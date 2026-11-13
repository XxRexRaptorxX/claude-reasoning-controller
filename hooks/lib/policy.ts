// Decision strategy: from an analysis, the person's settings, the model and
// the session's own level to the one effort level the turn's requests carry.
// Pure: every input is passed in, nothing is read or written here.

import { THRESHOLDS, levelForScore, type Analysis } from './classifier'
import { clampLevel, label, maxOf, minOf, rank, type Level } from './levels'
import { nearestSupported, profileFor, type ModelProfile } from './models'
import type { Mode, Settings } from './settings'

export type DecisionSource =
  | 'auto' // the controller chose from the analysis
  | 'fallback' // analysis unsure: the model's/session's own level
  | 'continuation' // a follow-up keeps the previous level
  | 'override' // /reasoning <level> for this one task
  | 'keys' // a level picked with effort-cycle's keys (that plugin applies it)
  | 'manual' // MANUAL mode with a fixed level
  | 'session' // MANUAL mode, level left to /effort
  | 'unsupported' // the model takes no effort setting

export type Decision = {
  /** The level every request of the turn is sent with; undefined: untouched. */
  level: Level | undefined
  /** What the strategy asked for before the model's levels were applied. */
  requested: Level | undefined
  source: DecisionSource
  mode: Mode
  categoryLabel: string
  /** Short, user-facing reasons (task traits and adjustments). */
  reasons: string[]
  /** Technical notes: substitutions, clamps, kept levels. */
  notes: string[]
  confidence: number
  score: number
  /** The session's level for this model as the engine reported it. */
  baseline: Level | undefined
  model: string
  family: string
  escalated: boolean
}

export type Previous = { level: Level; score: number; source: DecisionSource }

export type DecideInput = {
  analysis: Analysis
  settings: Settings
  model: string
  /** `effort` as turn.step reported it; undefined: the model takes none. */
  baseline: Level | undefined
  /** A pending /reasoning override for this task. */
  override?: Level
  /** The decision of the previous main-loop turn. */
  previous?: Previous
  /** How many messages the request carries (prompt-cache awareness). */
  messageCount?: number
  /** A level the optional AI classifier proposed. */
  aiHint?: Level
}

type Profile = { shift: number; cap?: Level; floor?: Level; allowMaxRule: boolean; prefer: 'down' | 'up' }

/** One band of the score scale: the priority slider moves a task by about one level. */
const PRIORITY_SHIFT = 2

/** How each working mode turns the analysis into a level. */
export function modeProfile(settings: Settings): Profile {
  switch (settings.mode) {
    case 'balanced':
      return { shift: 0, cap: 'xhigh', allowMaxRule: false, prefer: 'down' }
    case 'quality':
      return { shift: PRIORITY_SHIFT, floor: 'medium', allowMaxRule: true, prefer: 'up' }
    case 'speed':
      return { shift: -PRIORITY_SHIFT, cap: 'high', allowMaxRule: false, prefer: 'down' }
    default: {
      // auto: the cost/time priority slider steers it.
      if (settings.priority === 'efficiency') return { shift: -PRIORITY_SHIFT, allowMaxRule: false, prefer: 'down' }
      if (settings.priority === 'quality') return { shift: PRIORITY_SHIFT, allowMaxRule: true, prefer: 'up' }
      return { shift: 0, allowMaxRule: true, prefer: 'down' }
    }
  }
}

const LONG_CONVERSATION = 40
const HYSTERESIS = 0.5

export function decide(input: DecideInput): Decision {
  const { analysis, settings } = input
  const profile = profileFor(input.model)
  const base: Omit<Decision, 'level' | 'requested' | 'source'> = {
    mode: settings.mode,
    categoryLabel: analysis.categoryLabel,
    reasons: [...analysis.traits],
    notes: [],
    confidence: analysis.confidence,
    score: analysis.score,
    baseline: input.baseline,
    model: input.model,
    family: profile.family,
    escalated: false,
  }

  if (input.baseline === undefined || profile.levels.length === 0) {
    return {
      ...base,
      level: undefined,
      requested: undefined,
      source: 'unsupported',
      reasons: ['Dieses Modell nimmt keine Effort-Einstellung an'],
    }
  }

  // 1. A /reasoning override wins over everything the person configured.
  if (input.override !== undefined) {
    return finish(base, profile, input.override, 'override', 'down', undefined, ['manuell für diesen Auftrag gewählt'])
  }

  // 2. MANUAL mode.
  if (settings.mode === 'manual') {
    if (settings.manualLevel === undefined) {
      return {
        ...base,
        level: undefined,
        requested: input.baseline,
        source: 'session',
        reasons: ['MANUAL: Sitzungsstufe (/effort) bleibt unverändert'],
      }
    }
    return finish(base, profile, settings.manualLevel, 'manual', 'down', undefined, ['MANUAL: feste Stufe aus den Einstellungen'])
  }

  const mp = modeProfile(settings)
  const bounds = boundsFor(settings, mp)

  // 3. A short follow-up continues the task at the level it had.
  if (analysis.isContinuation && input.previous !== undefined) {
    return finish(base, profile, input.previous.level, 'continuation', mp.prefer, undefined, [
      'Fortsetzung des vorherigen Auftrags',
    ])
  }
  if (analysis.isContinuation) {
    // Nothing to continue from (new session, reload): the session's level.
    const level = clampLevel(input.baseline, bounds.min, bounds.max)
    return finish(base, profile, level, 'fallback', mp.prefer, bounds.max, ['Fortsetzung ohne frühere Entscheidung: Sitzungsstufe'])
  }

  // 4. Automatic choice.
  const shifted = analysis.score + mp.shift
  const demand = levelForScore(shifted, analysis, mp.allowMaxRule)
  const notes: string[] = []
  let requested: Level
  let source: DecisionSource = 'auto'
  const reasons = [...analysis.traits]

  if (input.aiHint !== undefined && analysis.confidence < 0.6) {
    requested = input.aiHint
    notes.push(`KI-Klassifizierung: ${label(input.aiHint)}`)
  } else if (analysis.confidence < 0.5) {
    requested = input.baseline
    source = 'fallback'
    reasons.splice(0, reasons.length, 'Auftrag nicht eindeutig einzuordnen: Standardstufe der Sitzung')
  } else if (rank(demand) < rank(input.baseline) && analysis.confidence < 0.6) {
    // Lower than the session's level only for clearly simple tasks.
    requested = input.baseline
    notes.push('nur bei eindeutig einfachen Aufträgen unter die Standardstufe')
  } else {
    requested = demand
  }

  if (mp.cap !== undefined) requested = minOf(requested, mp.cap)
  if (mp.floor !== undefined) requested = maxOf(requested, mp.floor)
  const clamped = clampLevel(requested, bounds.min, bounds.max)
  if (clamped !== requested) notes.push(`${label(requested)} durch Einstellungen auf ${label(clamped)} begrenzt`)
  requested = clamped

  // 5. Avoid needless switching: a close call keeps the previous level, and a
  // long conversation is not stepped down by one level (on models that take
  // effort per request a change rewrites the prompt cache).
  const prev = input.previous
  if (prev !== undefined && prev.source !== 'override' && prev.source !== 'keys' && requested !== prev.level) {
    const prevLevel = clampLevel(prev.level, bounds.min, bounds.max)
    const diff = rank(requested) - rank(prevLevel)
    if (Math.abs(diff) === 1) {
      const boundary = THRESHOLDS[Math.min(rank(requested), rank(prevLevel))] ?? 0
      const isClose = Math.abs(shifted - boundary) < HYSTERESIS && source === 'auto'
      const isLongStepDown = diff === -1 && (input.messageCount ?? 0) >= LONG_CONVERSATION
      if (isClose || isLongStepDown) {
        notes.push(
          isClose
            ? `${label(prevLevel)} beibehalten (knappe Entscheidung)`
            : `${label(prevLevel)} beibehalten (langer Verlauf, Prompt-Cache)`,
        )
        requested = prevLevel
      }
    }
  }

  return finish({ ...base, notes, reasons }, profile, requested, source, mp.prefer, bounds.max)
}

function boundsFor(settings: Settings, mp: Profile): { min: Level; max: Level } {
  let max = settings.maxLevel
  if (mp.cap !== undefined) max = minOf(max, mp.cap)
  const min = minOf(settings.minLevel, max)
  return { min, max }
}

function finish(
  base: Omit<Decision, 'level' | 'requested' | 'source'>,
  profile: ModelProfile,
  requested: Level,
  source: DecisionSource,
  prefer: 'down' | 'up',
  ceiling: Level | undefined,
  extraReasons?: string[],
): Decision {
  const allowed = ceiling === undefined ? profile.levels : profile.levels.filter(l => rank(l) <= rank(ceiling))
  const level = nearestSupported(requested, allowed.length > 0 ? allowed : profile.levels, prefer)
  const notes = [...base.notes]
  if (level !== undefined && level !== requested) {
    notes.push(`${label(requested)} wird von ${profile.family} nicht unterstützt: ${label(level)}`)
  }
  if (!profile.isKnown) notes.push('Modell unbekannt: Claude Code passt nicht unterstützte Stufen selbst an')
  return {
    ...base,
    reasons: extraReasons ?? base.reasons,
    notes,
    level,
    requested,
    source,
  }
}

/**
 * The next level up for the rest of a task, within the person's maximum and
 * the model's levels; undefined when there is no room, or the decision was
 * the person's own (override, MANUAL) and must not be second-guessed.
 */
export function escalate(decision: Decision, settings: Settings): Level | undefined {
  if (decision.level === undefined) return undefined
  if (['override', 'keys', 'manual', 'session'].includes(decision.source)) return undefined
  const profile = profileFor(decision.model)
  const ceiling = minOf(settings.maxLevel, modeProfile(settings).cap ?? 'max')
  const next = profile.levels.find(l => rank(l) > rank(decision.level as Level) && rank(l) <= rank(ceiling))
  return next
}
