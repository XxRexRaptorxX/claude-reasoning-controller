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
  bandParts,
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
import {
  MANUAL_CHOICES,
  MAX_CHOICES,
  MIN_CHOICES,
  MODE_LABEL,
  MODES,
  PRIORITIES,
  PRIORITY_LABEL,
  parseSettings,
  type Field,
  type Settings,
} from './lib/settings'
import { ESCALATION_TOOL, PANE_ID, STATS_KEY } from './state'

const current = atom({ plugin: 'reasoning-controller', key: 'current' } as const, null, { shape: 'decision-1' })
const pending = atom({ plugin: 'reasoning-controller', key: 'pending' } as const, null)

// The settings pane: one row of buttons per choice field, one toggle per
// switch. A press reaches the `ui.press` hook below by the button's key
// (`<field>:<value>`, `<field>:toggle`, `close`); the buttons hold no handler.
type PaneRow = { field: Field; title: string; options: readonly string[]; labelOf: (o: string) => string }

const PANE_ROWS: readonly PaneRow[] = [
  { field: 'mode', title: 'Arbeitsmodus', options: MODES, labelOf: o => MODE_LABEL[o as keyof typeof MODE_LABEL] ?? o },
  { field: 'maxLevel', title: 'Maximale Stufe', options: MAX_CHOICES, labelOf: o => o.toUpperCase() },
  { field: 'minLevel', title: 'Minimale Stufe', options: MIN_CHOICES, labelOf: o => o.toUpperCase() },
  {
    field: 'priority',
    title: 'Kosten/Zeit',
    options: PRIORITIES,
    labelOf: o => PRIORITY_LABEL[o as keyof typeof PRIORITY_LABEL] ?? o,
  },
  {
    field: 'manualLevel',
    title: 'Stufe bei MANUAL',
    options: MANUAL_CHOICES,
    labelOf: o => (o === 'session' ? '/effort' : o.toUpperCase()),
  },
]

const PANE_TOGGLES: readonly { field: 'autoEscalation' | 'showDecision' | 'aiClassifier'; title: string }[] = [
  { field: 'autoEscalation', title: 'Automatische Eskalation' },
  { field: 'showDecision', title: 'Entscheidung anzeigen' },
  { field: 'aiClassifier', title: 'KI-Klassifizierung (kleines Modell)' },
]

function valueOf(s: Settings, field: Field): string | boolean {
  if (field === 'manualLevel') return s.manualLevel ?? 'session'
  return s[field]
}

/** The pane's buttons are answered by the ui.press hook, which takes every press; this is never reached. */
const handledByPressHook = (): void => undefined

/** A pane button's key as the field and value it sets; undefined for none. */
function pressedSetting(element: string, s: Settings): { field: Field; value: string | boolean } | undefined {
  const [field, value] = element.split(':')
  if (field === 'autoEscalation' || field === 'showDecision' || field === 'aiClassifier') {
    return value === 'toggle' ? { field, value: !s[field] } : undefined
  }
  const row = PANE_ROWS.find(r => r.field === field)
  return row && value !== undefined && row.options.includes(value) ? { field: row.field, value } : undefined
}

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
  const rt: Runtime = { settings, turns: new Map() }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'reasoning',
      description: 'Reasoning-Controller: Status, Stufe für den nächsten Auftrag, Modus und Einstellungen',
      argumentHint: '[low|medium|high|xhigh|max | auto | mode … | max-level … | settings]',
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

  // ---- escalation: Claude asks for it through this mod's own tool ----
  on('tool.call', { tool: 'mcp__reasoning-controller__request_more_reasoning' }, async ($, e) => {
    const raw = (e as { reason?: unknown }).reason
    const reason = typeof raw === 'string' ? raw.slice(0, 120) : ''
    const text = await escalateCurrent($, rt, `von Claude angefordert${reason ? ': ' + reason : ''}`, true)
    return { result: text }
  }).catch(() => ({ result: 'Escalation unavailable; continue at the current effort.' }))

  // ---- escalation: repeated tool failures (observes; never changes a result) ----
  on('tool.call', async ($, e, next) => {
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
  }).catch(($, e, next) => next(e))

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
        // The mod submits no prompts: text after the level is not sent.
        await update($, pending, () => action.level)
        const hint = action.prompt !== '' ? ' Den Auftrag bitte jetzt als eigene Nachricht senden.' : ''
        return { text: `Reasoning ${label(action.level)} für den nächsten Auftrag (einmalig).${hint}` }
      }
      case 'choice':
      case 'toggle': {
        // Writes only this mod's own /config rows (its userConfig fields).
        const value = action.value
        let r: { deny?: string | undefined }
        switch (action.field) {
          case 'mode':
            r = await $.config.set({ key: 'reasoning-controller.mode', value: value })
            break
          case 'maxLevel':
            r = await $.config.set({ key: 'reasoning-controller.maxLevel', value: value })
            break
          case 'minLevel':
            r = await $.config.set({ key: 'reasoning-controller.minLevel', value: value })
            break
          case 'priority':
            r = await $.config.set({ key: 'reasoning-controller.priority', value: value })
            break
          case 'manualLevel':
            r = await $.config.set({ key: 'reasoning-controller.manualLevel', value: value })
            break
          case 'autoEscalation':
            r = await $.config.set({ key: 'reasoning-controller.autoEscalation', value: value })
            break
          case 'showDecision':
            r = await $.config.set({ key: 'reasoning-controller.showDecision', value: value })
            break
          case 'aiClassifier':
            r = await $.config.set({ key: 'reasoning-controller.aiClassifier', value: value })
            break
        }
        const shown = typeof value === 'boolean' ? (value ? 'an' : 'aus') : value
        return { text: r.deny ? `Nicht geändert: ${r.deny}` : `${action.field} = ${shown} (gespeichert).` }
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

  // ---- the line above the prompt: mode, current level, limits ----
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = await read($, current)
    const p = await read($, pending)
    const { Box, Text } = $.ui.resolve(e)
    const parts = bandParts(v, settings, p)
    const nextLevel = p !== null ? ` | Next · ${p.toUpperCase()}` : ''
    return (
      <Box>
        <Text dimColor>Reasoning · {parts.mode} | Currently · </Text>
        <Text bold>{parts.level}</Text>
        <Text dimColor>
          {nextLevel} | {parts.limit}
        </Text>
      </Box>
    )
  })

  // ---- the settings pane (/reasoning settings) ----
  on('ui.render', { component: 'Pane', requestId: 'reasoning-settings' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, current)
    return (
      <Box flexDirection="column">
        <Text dimColor>Gilt für neue Aufträge. Gespeichert in den Einstellungen (auch unter /config).</Text>
        {PANE_ROWS.map(row => (
          <Box flexDirection="column">
            <Text bold>{row.title}</Text>
            <Box flexDirection="row" flexWrap="wrap">
              {row.options.map(o => (
                <Button
                  key={`${row.field}:${o}`}
                  label={row.labelOf(o)}
                  variant={valueOf(settings, row.field) === o ? 'primary' : 'secondary'}
                  onPress={handledByPressHook}
                />
              ))}
            </Box>
          </Box>
        ))}
        {PANE_TOGGLES.map(t => (
          <Box flexDirection="row">
            <Button key={`${t.field}:toggle`} label={`${settings[t.field] ? '[x]' : '[ ]'} ${t.title}`} plain onPress={handledByPressHook} />
          </Box>
        ))}
        <Text dimColor>
          {v === null || v.source === 'unsupported'
            ? 'Noch keine Entscheidung in dieser Sitzung.'
            : `Zuletzt: ${v.categoryLabel} → ${v.level ? label(v.level) : 'unverändert'}`}
        </Text>
        <Button key="close" label="Schließen" role="dismiss" onPress={handledByPressHook} />
      </Box>
    )
  })

  // ---- a press in the settings pane: write this mod's own /config row ----
  on('ui.press', { plugin: 'reasoning-controller', requestId: 'reasoning-settings' }, async ($, e) => {
    if (e.element === 'close') {
      await $.ui.close({ id: 'reasoning-settings' })
      return { element: e.element }
    }
    const pressed = pressedSetting(e.element, settings)
    if (pressed === undefined) return { element: e.element }
    const value = pressed.value
    switch (pressed.field) {
      case 'mode':
        await $.config.set({ key: 'reasoning-controller.mode', value: value })
        break
      case 'maxLevel':
        await $.config.set({ key: 'reasoning-controller.maxLevel', value: value })
        break
      case 'minLevel':
        await $.config.set({ key: 'reasoning-controller.minLevel', value: value })
        break
      case 'priority':
        await $.config.set({ key: 'reasoning-controller.priority', value: value })
        break
      case 'manualLevel':
        await $.config.set({ key: 'reasoning-controller.manualLevel', value: value })
        break
      case 'autoEscalation':
        await $.config.set({ key: 'reasoning-controller.autoEscalation', value: value })
        break
      case 'showDecision':
        await $.config.set({ key: 'reasoning-controller.showDecision', value: value })
        break
      case 'aiClassifier':
        await $.config.set({ key: 'reasoning-controller.aiClassifier', value: value })
        break
    }
    return { element: e.element }
  })
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
  return `Effort raised to ${to} for the remaining requests of this task (where effort is set per message, from the next user message).`
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
