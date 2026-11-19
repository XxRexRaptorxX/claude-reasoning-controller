// Decision strategy: from an analysis, the person's settings, the model and
// the session's own level to the one effort level the turn's requests carry.
// Pure: every input is passed in, nothing is read or written here.

import { THRESHOLDS, levelForScore, type Analysis } from './classifier'
import { clampLevel, label, maxOf, minOf, rank, step, type Level } from './levels'
import { nearestSupported, profileFor, type ModelProfile } from './models'
import type { RuleEffect } from './rules'
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
  /** Whole levels learned from your overrides for this task type (-1, 0, +1). */
  learnedShift?: number
  /** What your own rules say about this prompt. */
  ruleEffect?: RuleEffect
}

type Profile = { shift: number; cap?: Level; floor?: Level; allowMaxRule: boolean; prefer: 'down' | 'up' }

/** One band of the score scale: SPEED and QUALITY move a task by about one level. */
const MODE_SHIFT = 2

/**
 * How each working mode turns the analysis into a level.
 * AUTO: as analysed. SPEED: one level lower, at most HIGH, no MAX.
 * QUALITY: one level higher, at least MEDIUM, a missing level rounded up.
 * (MANUAL never gets here.) For "never MAX" in AUTO, set the max level.
 */
export function modeProfile(settings: Settings): Profile {
  switch (settings.mode) {
    case 'quality':
      return { shift: MODE_SHIFT, floor: 'medium', allowMaxRule: true, prefer: 'up' }
    case 'speed':
      return { shift: -MODE_SHIFT, cap: 'high', allowMaxRule: false, prefer: 'down' }
    default:
      return { shift: 0, allowMaxRule: true, prefer: 'down' }
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
      reasons: ['This model takes no effort setting'],
    }
  }

  // 1. A /reasoning override wins over everything the person configured.
  if (input.override !== undefined) {
    return finish(base, profile, input.override, 'override', 'down', undefined, ['chosen manually for this task'])
  }

  // 2. MANUAL mode.
  if (settings.mode === 'manual') {
    if (settings.manualLevel === undefined) {
      return {
        ...base,
        level: undefined,
        requested: input.baseline,
        source: 'session',
        reasons: ['MANUAL: session level (/effort) left unchanged'],
      }
    }
    return finish(base, profile, settings.manualLevel, 'manual', 'down', undefined, ['MANUAL: fixed level from the settings'])
  }

  const mp = modeProfile(settings)
  const bounds = boundsFor(settings, mp)

  // 3. A short follow-up continues the task at the level it had.
  if (analysis.isContinuation && input.previous !== undefined) {
    return finish(base, profile, input.previous.level, 'continuation', mp.prefer, undefined, [
      'continues the previous task',
    ])
  }
  if (analysis.isContinuation) {
    // Nothing to continue from (new session, reload): the session's level.
    const level = clampLevel(input.baseline, bounds.min, bounds.max)
    return finish(base, profile, level, 'fallback', mp.prefer, bounds.max, ['follow-up without an earlier decision: session level'])
  }

  // 4. Automatic choice.
  const shifted = analysis.score + mp.shift
  const demand = levelForScore(shifted, analysis, mp.allowMaxRule)
  const notes: string[] = []
  let requested: Level
  let source: DecisionSource = 'auto'
  const reasons = [...analysis.traits]

  if (input.aiHint !== undefined && (settings.aiClassification === 'always' || analysis.confidence < 0.6)) {
    requested = input.aiHint
    notes.push(`AI classification: ${label(input.aiHint)}`)
  } else if (analysis.confidence < 0.5) {
    requested = input.baseline
    source = 'fallback'
    reasons.splice(0, reasons.length, 'task not clearly classifiable: session default level')
  } else if (rank(demand) < rank(input.baseline) && analysis.confidence < 0.6) {
    // Lower than the session's level only for clearly simple tasks.
    requested = input.baseline
    notes.push('goes below the default level only for clearly simple tasks')
  } else {
    requested = demand
  }

  if (input.learnedShift) {
    requested = step(requested, input.learnedShift)
    notes.push(`learned from your overrides: ${input.learnedShift > 0 ? 'one level up' : 'one level down'}`)
  }
  const re = input.ruleEffect
  if (re) {
    if (re.exact) requested = re.exact
    if (re.min) requested = maxOf(requested, re.min)
    if (re.max) requested = minOf(requested, re.max)
    notes.push(...re.notes)
  }

  if (mp.cap !== undefined) requested = minOf(requested, mp.cap)
  if (mp.floor !== undefined) requested = maxOf(requested, mp.floor)
  const clamped = clampLevel(requested, bounds.min, bounds.max)
  if (clamped !== requested) notes.push(`${label(requested)} limited to ${label(clamped)} by the settings`)
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
            ? `kept ${label(prevLevel)} (close call)`
            : `kept ${label(prevLevel)} (long conversation, prompt cache)`,
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
    notes.push(`${label(requested)} is not supported by ${profile.family}: ${label(level)}`)
  }
  if (!profile.isKnown) notes.push('unknown model: Claude Code adjusts unsupported levels itself')
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
