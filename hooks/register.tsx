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
import { isLevel, label, LEVELS, type Level } from './lib/levels'
import { decide, escalate, type Decision, type Previous } from './lib/policy'
import {
  AI_MODES,
  MANUAL_CHOICES,
  MAX_CHOICES,
  MIN_CHOICES,
  MODE_LABEL,
  MODES,
  parseSettings,
  type Field,
  type Settings,
} from './lib/settings'
import { ESCALATION_TOOL, LEARN_KEY, PANE_ID, STATS_KEY, USAGE_KEY } from './state'
import { applyRules, parseProfiles, parseRules, profileForFolder, type ProjectProfile, type RuleEffect } from './lib/rules'
import { learnedShift, readLearned, readUsage, recordCorrection, recordUsage, usageSummary } from './lib/learning'

const current = atom({ plugin: 'reasoning-controller', key: 'current' } as const, null, { shape: 'decision-1' })
const pending = atom({ plugin: 'reasoning-controller', key: 'pending' } as const, null)

// The settings pane: one row of buttons per choice field, one toggle per
// switch. A press reaches the `ui.press` hook below by the button's key
// (`<field>:<value>`, `<field>:toggle`, `close`); the buttons hold no handler.
type PaneRow = { field: Field; title: string; options: readonly string[]; labelOf: (o: string) => string }

const PANE_ROWS: readonly PaneRow[] = [
  { field: 'mode', title: 'Working mode', options: MODES, labelOf: o => MODE_LABEL[o as keyof typeof MODE_LABEL] ?? o },
  { field: 'maxLevel', title: 'Max level', options: MAX_CHOICES, labelOf: o => o.toUpperCase() },
  { field: 'minLevel', title: 'Min level', options: MIN_CHOICES, labelOf: o => o.toUpperCase() },
  {
    field: 'manualLevel',
    title: 'Level in MANUAL mode',
    options: MANUAL_CHOICES,
    labelOf: o => (o === 'session' ? '/effort' : o.toUpperCase()),
  },
  { field: 'aiClassification', title: 'AI classification (small model)', options: AI_MODES, labelOf: o => o },
]

type ToggleField = 'autoEscalation' | 'showDecision' | 'showStatusLine' | 'learnFromOverrides'

const PANE_TOGGLES: readonly { field: ToggleField; title: string }[] = [
  { field: 'autoEscalation', title: 'Automatic escalation' },
  { field: 'showDecision', title: 'Show decision' },
  { field: 'showStatusLine', title: 'Show the status line' },
  { field: 'learnFromOverrides', title: 'Learn from my overrides' },
]

/** Colour per level on the status line: cool to hot, by theme key. */
const HEAT: Record<Level, 'inactive' | 'success' | 'warning' | 'claude' | 'error'> = {
  low: 'inactive',
  medium: 'success',
  high: 'warning',
  xhigh: 'claude',
  max: 'error',
}

/** A click on the level picks the next task's level: auto, low … max, auto. */
function nextPending(p: Level | null): Level | null {
  if (p === null) return 'low'
  const i = LEVELS.indexOf(p)
  return i === LEVELS.length - 1 ? null : (LEVELS[i + 1] ?? null)
}

function valueOf(s: Settings, field: Field): string | boolean {
  if (field === 'manualLevel') return s.manualLevel ?? 'session'
  return s[field]
}

function isToggle(field: string | undefined): field is ToggleField {
  return PANE_TOGGLES.some(t => t.field === field)
}

/** The pane's buttons are answered by the ui.press hook, which takes every press; this is never reached. */
const handledByPressHook = (): void => undefined

/** A pane button's key as the field and value it sets; undefined for none. */
function pressedSetting(element: string, s: Settings): { field: Field; value: string | boolean } | undefined {
  const [field, value] = element.split(':')
  if (isToggle(field)) {
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
  /** What your own rules say about this prompt (no prompt text kept). */
  ruleEffect?: RuleEffect
}

/** What the hooks of one load share (module memory; reset by a reload). */
type Runtime = {
  settings: Settings
  turns: Map<string, TurnInfo>
  mainTurnId?: string
  previous?: Previous
  /** The project profile in force for this session's folder. */
  profile?: ProjectProfile
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
  const { rules, invalid: invalidRules } = parseRules(settings.rules)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'reasoning',
      description: 'Reasoning controller: status, level for the next task, mode and settings',
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
    // A project profile replaces min/max for this session's folder.
    const { profiles } = parseProfiles(settings.projectProfiles)
    if (profiles.length > 0) {
      const cwd = await sessionFolder($)
      const profile = profileForFolder(cwd, profiles)
      if (profile) {
        rt.profile = profile
        if (profile.max) settings.maxLevel = profile.max
        if (profile.min) settings.minLevel = profile.min
        if (LEVELS.indexOf(settings.minLevel) > LEVELS.indexOf(settings.maxLevel)) settings.minLevel = settings.maxLevel
      }
    }
    return next(e)
  })

  // ---- analysis at the start of each main-loop turn ----
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const analysis = analyze(e.text)
    const info: TurnInfo = { analysis, toolErrors: 0, modelRequests: 0 }
    if (rules.length > 0) {
      const effect = applyRules(e.text, rules)
      if (effect.notes.length > 0) info.ruleEffect = effect
    }
    if (e.text.trim() !== '') {
      const p = await read($, pending)
      if (p !== null) {
        info.override = p
        await update($, pending, () => null)
      }
    }
    // The small model decides for every new task ("always"), or only where
    // the local analysis is unsure ("unclear").
    const wantsAi =
      (settings.aiClassification === 'always' ||
        (settings.aiClassification === 'unclear' && analysis.confidence < 0.6)) &&
      settings.mode !== 'manual' &&
      info.override === undefined &&
      !analysis.isContinuation &&
      e.text.trim().length >= 3
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
      const learned = settings.learnFromOverrides ? readLearned(await $.store.get(LEARN_KEY)) : undefined
      const shift = learned ? learnedShift(learned, info.analysis.category) : 0
      const inputs = {
        analysis: info.analysis,
        settings,
        model: e.model,
        baseline: isLevel(e.effort) ? e.effort : undefined,
        ...(previous ? { previous } : {}),
        messageCount: e.messageCount,
        ...(aiHint ? { aiHint } : {}),
        ...(shift !== 0 ? { learnedShift: shift } : {}),
        ...(info.ruleEffect ? { ruleEffect: info.ruleEffect } : {}),
      }
      const decided = decide({ ...inputs, ...(override ? { override } : {}) })
      // Learn from a /reasoning override: how far it was from the automatic choice.
      if (learned && keys === undefined && decided.source === 'override' && decided.level && !info.analysis.isContinuation) {
        const auto = decide(inputs)
        if (auto.level) await saveLearned($, recordCorrection(learned, info.analysis.category, auto.level, decided.level))
      }
      const decision: Decision =
        keys !== undefined && decided.source === 'override'
          ? {
              ...decided,
              source: 'keys',
              reasons: ['picked with the keyboard (effort-cycle, Ctrl+↑/↓)'],
              notes: info.override ? [...decided.notes, `/reasoning ${label(info.override)} skipped: the keyboard pick wins`] : decided.notes,
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
      // Cost overview: output tokens per level, counts only.
      const done = rt.turns.get(e.turnId)
      const ranAt = done?.escalatedTo ?? done?.decision?.level
      const out = e.usage?.output_tokens
      if (done?.decision && done.decision.source !== 'keys' && ranAt && typeof out === 'number') await bumpUsage($, ranAt, out)
      rt.turns.delete(e.turnId)
      if (rt.mainTurnId === e.turnId) delete rt.mainTurnId
    }
    return next(e)
  })

  // ---- escalation: Claude asks for it through this mod's own tool ----
  on('tool.call', { tool: 'mcp__reasoning-controller__request_more_reasoning' }, async ($, e) => {
    const raw = (e as { reason?: unknown }).reason
    const reason = typeof raw === 'string' ? raw.slice(0, 120) : ''
    const text = await escalateCurrent($, rt, `requested by Claude${reason ? ': ' + reason : ''}`, true)
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
          await escalateCurrent($, rt, `${TOOL_ERRORS_TO_ESCALATE} failed tool calls`, false)
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
        const extra: string[] = []
        if (rt.profile) {
          extra.push(`Project profile "${rt.profile.match}": ${[rt.profile.min ? 'min ' + label(rt.profile.min) : '', rt.profile.max ? 'max ' + label(rt.profile.max) : ''].filter(Boolean).join(', ')}`)
        }
        if (rules.length > 0) extra.push(`Rules: ${rules.map(r => r.text + r.op + label(r.level)).join('; ')}`)
        if (invalidRules.length > 0) extra.push(`Ignored rules (format "text=level", "text>=level", "text<=level"): ${invalidRules.join('; ')}`)
        const learnedNow = readLearned(await $.store.get(LEARN_KEY))
        const adjusted = Object.keys(learnedNow.byCategory).flatMap(c => {
          const s = learnedShift(learnedNow, c as Analysis['category'])
          return s !== 0 ? [`${c} ${s > 0 ? '+1' : '-1'}`] : []
        })
        if (settings.learnFromOverrides && adjusted.length > 0) extra.push(`Learned from your overrides: ${adjusted.join(', ')}`)
        extra.push(...usageSummary(readUsage(await $.store.get(USAGE_KEY))))
        const base = statusText(await read($, current), settings, await read($, pending), stats)
        return { text: [base, ...extra].join('\n') }
      }
      case 'clear':
        await update($, pending, () => null)
        return { text: 'No override: the next task is classified automatically.' }
      case 'override': {
        // The mod submits no prompts: text after the level is not sent.
        await update($, pending, () => action.level)
        const hint = action.prompt !== '' ? ' Now send the task as a message of its own.' : ''
        return { text: `Reasoning ${label(action.level)} for the next task (once).${hint}` }
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
          case 'manualLevel':
            r = await $.config.set({ key: 'reasoning-controller.manualLevel', value: value })
            break
          case 'autoEscalation':
            r = await $.config.set({ key: 'reasoning-controller.autoEscalation', value: value })
            break
          case 'showDecision':
            r = await $.config.set({ key: 'reasoning-controller.showDecision', value: value })
            break
          case 'aiClassification':
            r = await $.config.set({ key: 'reasoning-controller.aiClassification', value: value })
            break
          case 'showStatusLine':
            r = await $.config.set({ key: 'reasoning-controller.showStatusLine', value: value })
            break
          case 'learnFromOverrides':
            r = await $.config.set({ key: 'reasoning-controller.learnFromOverrides', value: value })
            break
        }
        const shown = typeof value === 'boolean' ? (value ? 'on' : 'off') : value
        return { text: r.deny ? `Not changed: ${r.deny}` : `${action.field} = ${shown} (saved).` }
      }
      case 'settings': {
        const r = await $.ui.open({ id: PANE_ID, title: 'Reasoning settings', focus: true, closeOnEscape: true })
        return { text: r.isPlaced ? 'Settings opened.' : 'Settings: /config (rows "Reasoning: …").' }
      }
      case 'reset-stats':
        await $.store.delete(STATS_KEY)
        await $.store.delete(USAGE_KEY)
        return { text: 'Statistics and token counts cleared.' }
      case 'reset-learning':
        await $.store.delete(LEARN_KEY)
        return { text: 'Forgot what was learned from your overrides.' }
      case 'error':
        return { text: action.message }
    }
  })

  // ---- the status line under the input ----
  // Terminal: at the left of the hint line ("? for shortcuts"), PromptHint.
  // Desktop app: the footer under the input has only a narrow slot on the
  // right, so the bar goes into the band above the input, at its left, beside
  // whatever other plugins put there (effort-cycle's hidden key buttons).
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!settings.showStatusLine || e.surface !== 'terminal') return next(e)
    const engineHint = await next(e)
    const bar = statusBar($.ui.resolve(e), await read($, current), await read($, pending), settings, true)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        {bar}
        <Text>{'    '}</Text>
        {engineHint}
      </Box>
    )
  })

  // Desktop app: the footer under the input has only a narrow slot, so the
  // bar goes into the band above the input, at its left, beside whatever
  // other plugins put there (effort-cycle's hidden key buttons).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!settings.showStatusLine || e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
    const others = await next(e)
    const bar = statusBar($.ui.resolve(e), await read($, current), await read($, pending), settings, false)
    const { Box } = $.ui.resolve(e)
    return (
      <Box>
        {bar}
        {others}
      </Box>
    )
  })

  // ---- the settings pane (/reasoning settings) ----
  on('ui.render', { component: 'Pane', requestId: 'reasoning-settings' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, current)
    return (
      <Box flexDirection="column">
        <Text dimColor>Applies to new tasks. Saved in your settings (also under /config).</Text>
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
            ? 'No decision in this session yet.'
            : `Last: ${v.categoryLabel} → ${v.level ? label(v.level) : 'unchanged'}`}
        </Text>
        <Button key="close" label="Close" role="dismiss" onPress={handledByPressHook} />
      </Box>
    )
  })

  // ---- a click on the status line ----
  on('ui.press', { plugin: 'reasoning-controller', component: 'PromptHint' }, async ($, e) => {
    if (e.element === 'band-level') await update($, pending, p => nextPending(p))
    if (e.element === 'band-mode') await $.ui.open({ id: PANE_ID, title: 'Reasoning settings', focus: true, closeOnEscape: true })
    return { element: e.element }
  })

  on('ui.press', { plugin: 'reasoning-controller', component: 'AbovePrompt' }, async ($, e) => {
    if (e.element === 'band-level') await update($, pending, p => nextPending(p))
    if (e.element === 'band-mode') await $.ui.open({ id: PANE_ID, title: 'Reasoning settings', focus: true, closeOnEscape: true })
    return { element: e.element }
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
      case 'manualLevel':
        await $.config.set({ key: 'reasoning-controller.manualLevel', value: value })
        break
      case 'autoEscalation':
        await $.config.set({ key: 'reasoning-controller.autoEscalation', value: value })
        break
      case 'showDecision':
        await $.config.set({ key: 'reasoning-controller.showDecision', value: value })
        break
      case 'aiClassification':
        await $.config.set({ key: 'reasoning-controller.aiClassification', value: value })
        break
      case 'showStatusLine':
        await $.config.set({ key: 'reasoning-controller.showStatusLine', value: value })
        break
      case 'learnFromOverrides':
        await $.config.set({ key: 'reasoning-controller.learnFromOverrides', value: value })
        break
      case 'rules':
      case 'projectProfiles':
        // Text settings: edited in /config, not in the pane.
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

type ElementTable = ReturnType<EngineInterface['ui']['resolve']>

/** An icon per working mode, before its name. */
const MODE_ICON: Record<Settings['mode'], string> = {
  auto: '◆',
  quality: '★',
  speed: '⚡',
  manual: '✋',
}

/**
 * Mode ◆ AUTO  ·  Reasoning ▰▰▰▱▱ HIGH  ·  Limit MAX, coloured like
 * effort-cycle's meter. `clickable`: the mode and the reasoning part are plain
 * Buttons (band-mode / band-level). The desktop app draws a Button as its own
 * native control, with padding and without the colours inside, so there the
 * bar is plain text.
 */
function statusBar(
  el: ElementTable,
  v: ReasoningDecisionView | null,
  p: Level | null,
  settings: Settings,
  clickable: boolean,
): ReturnType<ElementTable['Box']> {
  const { Box, Text, Button } = el
  const shown = v !== null && v.source !== 'unsupported' ? (v.level ?? v.baseline) : undefined
  const filled = shown ? LEVELS.indexOf(shown) + 1 : 0
  const heat = shown ? { color: HEAT[shown] } : {}
  const word = shown
    ? label(shown) + (v?.escalated ? ' ↑' : '')
    : v?.source === 'unsupported'
      ? '—'
      : settings.mode === 'manual' && settings.manualLevel === undefined
        ? '/effort'
        : 'READY'
  const limit = settings.minLevel !== 'low' ? `${label(settings.minLevel)}–${label(settings.maxLevel)}` : label(settings.maxLevel)
  const mode = [
    <Text dimColor>Mode </Text>,
    <Text color="claude">{MODE_ICON[settings.mode] + ' '}</Text>,
    <Text bold>{MODE_LABEL[settings.mode]}</Text>,
  ]
  const reasoning = [
    <Text dimColor>Reasoning </Text>,
    filled > 0 && <Text {...heat}>{'▰'.repeat(filled)}</Text>,
    filled < LEVELS.length && <Text dimColor>{'▱'.repeat(LEVELS.length - filled)}</Text>,
    <Text bold {...heat}>
      {' ' + word}
    </Text>,
  ]
  const SEP = '  ·  '
  return (
    <Box>
      {!clickable && (
        // Desktop: one small native button before the text opens the settings,
        // so the text after it keeps its spacing and colours.
        <Box marginRight={2}>
          <Button key="band-mode" label="⚙" plain onPress={handledByPressHook} />
        </Box>
      )}
      {clickable ? (
        <Button key="band-mode" plain onPress={handledByPressHook}>
          {mode}
        </Button>
      ) : (
        mode
      )}
      <Text dimColor>{SEP}</Text>
      {clickable ? (
        <Button key="band-level" plain onPress={handledByPressHook}>
          {reasoning}
        </Button>
      ) : (
        reasoning
      )}
      {p !== null && <Text dimColor>{`${SEP}Next ${label(p)}`}</Text>}
      <Text dimColor>{`${SEP}Limit ${limit}`}</Text>
    </Box>
  )
}

async function sessionFolder($: EngineInterface): Promise<string> {
  try {
    return await $.session.cwd()
  } catch {
    return ''
  }
}

async function saveLearned($: EngineInterface, learned: ReturnType<typeof readLearned>): Promise<void> {
  try {
    await $.store.set(LEARN_KEY, learned)
  } catch {
    // Learning is a convenience; a store failure must not touch the turn.
  }
}

async function bumpUsage($: EngineInterface, level: Level, outputTokens: number): Promise<void> {
  try {
    await $.store.set(USAGE_KEY, recordUsage(readUsage(await $.store.get(USAGE_KEY)), level, outputTokens))
  } catch {
    // The cost overview is a convenience; a store failure must not touch the turn.
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
      'How much reasoning effort a coding assistant needs for this request. trivial = a quick answer, a tiny edit or a ' +
      'routine operation (git commit/push, running tests, installing, building); routine = an ordinary, well-scoped code ' +
      'change; demanding = tricky debugging, side effects or careful analysis; extensive = large multi-file or autonomous ' +
      'work, architecture; critical = a very hard problem where correctness is critical (security, proofs). Judge the ' +
      'actual difficulty, not the length or single words. The request may be in any language.\n\n' +
      text.slice(0, 4000)
    const labelled = await $.model.classify(prompt, AI_LABELS)
    return labelled === undefined ? undefined : AI_TO_LEVEL[labelled as (typeof AI_LABELS)[number]]
  } catch {
    return undefined
  }
}
