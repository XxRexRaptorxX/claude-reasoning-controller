// Adaptive Reasoning Controller.
//
// How the effort is actually changed: Claude Code raises `turn.step` for every
// model request of a turn, with the `effort` the request will carry (the
// session's /effort level or the model's default; absent for a model that
// takes none). A hook may send the request with another level:
// `next({ ...e, effort })`. That is the real API parameter, not a hint in the
// prompt. A rewrite holds for that one request, so this mod rewrites every
// step of the main loop's turn. The prompt itself is never changed.
//
// Flow: turn.start (main loop) analyses the task locally and takes a pending
// /reasoning override; the turn's first step decides (it knows the model, the
// session's level and the conversation length); every step of the turn is
// sent at that level, raised by an escalation when one happens. Subagents
// keep their own effort (their definitions set it).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReasoningDecisionView } from '../types'
import { analyze, type Analysis } from './lib/classifier'
import {
  countDecision,
  decisionNotice,
  escalationNotice,
  HELP,
  parseCommand,
  readStats,
  statusText,
  toView,
  type Stats,
} from './lib/format'
import { isLevel, label, type Level } from './lib/levels'
import { decide, escalate, type Decision, type Previous } from './lib/policy'
import { parseSettings, type Settings } from './lib/settings'
import { ESCALATION_TOOL, PANE_ID, STATS_KEY } from './state'

const current = atom({ plugin: 'reasoning-controller', key: 'current' } as const, null, { shape: 'decision-1' })
const pending = atom({ plugin: 'reasoning-controller', key: 'pending' } as const, null)
import { registerUi, setOption } from './ui'

// The effort-cycle plugin (Anerco) lets the person pick a level with Ctrl+↑/↓
// and applies it in its own turn.step hook. Its pick wins over this mod: while
// one is active for the model, requests pass through unchanged. Its `base` is
// the engine's own level as it last saw it; where this mod's hook runs above
// it, it would record this mod's level as the engine's and then drop the
// person's pick as "changed by /effort", so such a write is corrected to the
// engine's level (state.set below). Without effort-cycle both read null.
const KEYS_OVERRIDE = { plugin: 'effort-cycle', key: 'override' } as const

type TurnInfo = {
  analysis: Analysis
  override?: Level
  ai?: Promise<Level | undefined>
  decision?: Decision
  /** A higher level for the rest of the turn, once escalated. */
  escalatedTo?: Level
  toolErrors: number
  modelRequests: number
}

/** What the hooks of one load share (module memory; reset by a reload). */
type Runtime = {
  settings: Settings
  turns: Map<string, TurnInfo>
  mainTurnId?: string
  previous?: Previous
  perMessageEffort: boolean
  /** The step this mod is rewriting right now: the level it sent, the engine's. */
  injection?: { model: string; injected: Level; engine: string }
}

const TOOL_ERRORS_TO_ESCALATE = 3
const MAX_MODEL_REQUESTS = 2
const AI_LABELS = ['trivial', 'routine', 'demanding', 'extensive', 'critical'] as const
const AI_TO_LEVEL: Record<(typeof AI_LABELS)[number], Level> = {
  trivial: 'low',
  routine: 'medium',
  demanding: 'high',
  extensive: 'xhigh',
  critical: 'max',
}

export const register: Register = (on, options) => {
  const settings = parseSettings(options)
  const rt: Runtime = { settings, turns: new Map(), perMessageEffort: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'reasoning',
      description: 'Reasoning-Controller: Status, Stufe für den nächsten Auftrag, Modus und Einstellungen',
      argumentHint: '[low|medium|high|xhigh|max [Auftrag] | auto | mode … | max-level … | settings]',
      immediate: true,
    })
    if (settings.autoEscalation) {
      await $.tool.register({
        name: ESCALATION_TOOL,
        description:
          'Raise the reasoning effort for the rest of the current task. Call only when the task has proven clearly harder than it looked (repeated failed attempts, unexpected interactions, a subtle root cause) and more careful reasoning would help. Never call it for routine work.',
        inputSchema: {
          type: 'object',
          properties: { reason: { type: 'string', description: 'One short sentence: why more reasoning is needed.' } },
          required: ['reason'],
        },
        isDeferred: false,
      })
    }
    const caps = await $.env.get('CLAUDE_CODE_MODEL_CAPABILITIES')
    rt.perMessageEffort = (caps ?? '').includes('per_turn_effort')
    return next(e)
  })

  // ---- analysis at the start of each main-loop turn ----
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const analysis = analyze(e.text)
    const info: TurnInfo = { analysis, toolErrors: 0, modelRequests: 0 }
    if (e.text.trim() !== '') {
      const p = await read($, pending)
      if (p !== null) {
        info.override = p
        await update($, pending, () => null)
      }
    }
    const wantsAi =
      settings.aiClassifier &&
      settings.mode !== 'manual' &&
      info.override === undefined &&
      !analysis.isContinuation &&
      analysis.confidence < 0.6 &&
      e.text.trim().length >= 15
    if (wantsAi) info.ai = classifyWithModel($, e.text)
    rt.turns.set(e.turnId, info)
    rt.mainTurnId = e.turnId
    return next(e)
  })

  // ---- the actual effort change, per model request ----
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || typeof e.effort === 'number') return yield* next(e)
    const info = rt.turns.get(e.turnId)
    if (info === undefined) return yield* next(e)
    const keys = await keysChoice($, e.model)

    if (info.decision === undefined) {
      const aiHint = info.ai ? await info.ai : undefined
      if (rt.previous === undefined) rt.previous = await previousFromState($)
      const previous = rt.previous
      const override = keys ?? info.override
      const decided = decide({
        analysis: info.analysis,
        settings,
        model: e.model,
        baseline: isLevel(e.effort) ? e.effort : undefined,
        ...(override ? { override } : {}),
        ...(previous ? { previous } : {}),
        messageCount: e.messageCount,
        ...(aiHint ? { aiHint } : {}),
      })
      const decision: Decision =
        keys !== undefined && decided.source === 'override'
          ? {
              ...decided,
              source: 'keys',
              reasons: ['per Tastatur gewählt (effort-cycle, Strg+↑/↓)'],
              notes: info.override ? [...decided.notes, `/reasoning ${label(info.override)} übergangen: Tastatur-Wahl hat Vorrang`] : decided.notes,
            }
          : decided
      info.decision = decision
      if (decision.level !== undefined) {
        rt.previous = { level: decision.level, score: decision.score, source: decision.source }
      }
      const view = toView(e.turnId, decision)
      await update($, current, () => view)
      if (settings.showDecision && decision.source !== 'continuation') $.ui.log(decisionNotice(view))
      await bumpStats($, s => countDecision(s, decision))
    }

    // A key pick (even one made mid-task) is applied by effort-cycle itself.
    if (keys !== undefined) return yield* next(e)
    const level = info.escalatedTo ?? info.decision.level
    if (level === undefined || level === e.effort) return yield* next(e)
    rt.injection = { model: e.model, injected: level, engine: e.effort ?? level }
    try {
      return yield* next({ ...e, effort: level })
    } finally {
      delete rt.injection
    }
  })

  // effort-cycle records the engine's level as `base`; keep it the engine's.
  on('state.set', { plugin: 'effort-cycle', key: 'base' }, ($, e, next) => {
    const inj = rt.injection
    const v = e.value as { model?: unknown; level?: unknown } | null
    if (inj !== undefined && v !== null && v.model === inj.model && v.level === inj.injected) {
      return next({ ...e, value: { model: inj.model, level: inj.engine } })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      rt.turns.delete(e.turnId)
      if (rt.mainTurnId === e.turnId) delete rt.mainTurnId
    }
    return next(e)
  })

  // ---- escalation: repeated tool failures, or Claude asks for it ----
  on('tool.call', async ($, e, next) => {
    if (String(e.tool).endsWith(`__${ESCALATION_TOOL}`)) {
      const raw = (e as { reason?: unknown }).reason
      const reason = typeof raw === 'string' ? raw.slice(0, 120) : ''
      const text = await escalateCurrent($, rt, `von Claude angefordert${reason ? ': ' + reason : ''}`, true)
      return { result: text }
    }
    const result = await next(e)
    if (settings.autoEscalation && e.agentId === undefined && result.deny === undefined && result.isError === true) {
      const info = rt.mainTurnId ? rt.turns.get(rt.mainTurnId) : undefined
      if (info) {
        info.toolErrors += 1
        if (info.toolErrors === TOOL_ERRORS_TO_ESCALATE && info.escalatedTo === undefined) {
          await escalateCurrent($, rt, `${TOOL_ERRORS_TO_ESCALATE} fehlgeschlagene Tool-Aufrufe`, false)
        }
      }
    }
    return result
  }).catch(($, e, next) =>
    // Never let a failure here change a tool's outcome: replay what the tool
    // answered, or answer the escalation tool without escalating.
    next.called || !String(e.tool).endsWith(`__${ESCALATION_TOOL}`)
      ? next(e)
      : { result: 'Escalation unavailable; continue at the current effort.' },
  )

  // ---- /reasoning ----
  on('command.run', { command: 'reasoning' }, async ($, e) => {
    const action = parseCommand(e.args)
    switch (action.kind) {
      case 'help':
        return { text: HELP }
      case 'status': {
        const stats = readStats(await $.store.get(STATS_KEY))
        return { text: statusText(await read($, current), settings, await read($, pending), stats) }
      }
      case 'clear':
        await update($, pending, () => null)
        return { text: 'Keine Überschreibung: der nächste Auftrag wird automatisch eingestuft.' }
      case 'override': {
        await update($, pending, () => action.level)
        if (action.prompt !== '') {
          await $.prompt.submit({ text: action.prompt, asUser: true })
          return { text: `Reasoning ${label(action.level)} für diesen Auftrag.` }
        }
        return { text: `Reasoning ${label(action.level)} für den nächsten Auftrag (einmalig).` }
      }
      case 'set': {
        const deny = await setOption($, action.field, action.value)
        return { text: deny ? `Nicht geändert: ${deny}` : `${action.field} = ${action.value} (gespeichert).` }
      }
      case 'toggle': {
        const deny = await setOption($, action.field, action.value)
        return { text: deny ? `Nicht geändert: ${deny}` : `${action.field} = ${action.value ? 'an' : 'aus'} (gespeichert).` }
      }
      case 'settings': {
        const r = await $.ui.open({ id: PANE_ID, title: 'Reasoning-Einstellungen', focus: true, closeOnEscape: true })
        return { text: r.isPlaced ? 'Einstellungen geöffnet.' : 'Einstellungen: /config (Zeilen "Reasoning: …").' }
      }
      case 'reset-stats':
        await $.store.delete(STATS_KEY)
        return { text: 'Statistik gelöscht.' }
      case 'error':
        return { text: action.message }
    }
  })

  registerUi(on, settings)
}

async function escalateCurrent($: EngineInterface, rt: Runtime, reason: string, byModel: boolean): Promise<string> {
  const { settings } = rt
  if (!settings.autoEscalation) return 'Automatic escalation is turned off in the settings; continue at the current effort.'
  const info = rt.mainTurnId ? rt.turns.get(rt.mainTurnId) : undefined
  if (info === undefined || info.decision === undefined) return 'No task is running; nothing to escalate.'
  if (byModel) {
    info.modelRequests += 1
    if (info.modelRequests > MAX_MODEL_REQUESTS) return 'Escalation limit for this task reached; continue at the current effort.'
  }
  const from = info.escalatedTo ?? info.decision.level
  const to = escalate({ ...info.decision, level: from }, settings)
  if (to === undefined) {
    const isManual = ['override', 'keys', 'manual', 'session'].includes(info.decision.source)
    const why = isManual
      ? 'the level was set manually'
      : `already at the highest allowed level (${from ?? settings.maxLevel})`
    return `Effort not raised: ${why}. Continue carefully at the current effort.`
  }
  info.escalatedTo = to
  rt.previous = { level: to, score: info.decision.score, source: info.decision.source }
  await update($, current, v =>
    v === null ? v : ({ ...v, level: to, escalated: true, escalationReason: reason } satisfies ReasoningDecisionView),
  )
  await bumpStats($, s => ({ ...s, escalations: s.escalations + 1 }))
  if (settings.showDecision) $.ui.log(escalationNotice(from, to, reason))
  return rt.perMessageEffort
    ? `Effort raised to ${to}; it takes effect from the next user message (this model takes effort per message).`
    : `Effort raised to ${to} for the remaining requests of this task.`
}

/** The level picked with effort-cycle's keys for this model, if any. */
async function keysChoice($: EngineInterface, model: string): Promise<Level | undefined> {
  try {
    const { value } = await $.state.get(KEYS_OVERRIDE)
    return value != null && value.model === model && isLevel(value.level) ? value.level : undefined
  } catch {
    return undefined
  }
}

async function previousFromState($: EngineInterface): Promise<Previous | undefined> {
  const v = await read($, current)
  if (v === null || v.level === undefined) return undefined
  return { level: v.level, score: v.score, source: v.source }
}

async function bumpStats($: EngineInterface, fn: (s: Stats) => Stats): Promise<void> {
  try {
    await $.store.set(STATS_KEY, fn(readStats(await $.store.get(STATS_KEY))))
  } catch {
    // Statistics are a convenience; a store failure must not touch the turn.
  }
}

async function classifyWithModel($: EngineInterface, text: string): Promise<Level | undefined> {
  try {
    const prompt =
      'Effort a coding assistant needs for this request (trivial = quick answer or tiny edit; routine = ordinary change; ' +
      'demanding = tricky debugging or careful analysis; extensive = large multi-file/autonomous work; critical = ' +
      'very hard problem where correctness is critical).\n\n' +
      text.slice(0, 4000)
    const labelled = await $.model.classify(prompt, AI_LABELS)
    return labelled === undefined ? undefined : AI_TO_LEVEL[labelled as (typeof AI_LABELS)[number]]
  } catch {
    return undefined
  }
}
