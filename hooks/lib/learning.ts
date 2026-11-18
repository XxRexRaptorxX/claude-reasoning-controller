// Learning from your corrections, and the token statistics per level.
// Pure: the caller reads and writes $.store. Only task types, level steps and
// token counts are kept; never prompt text.

import { LEVELS, rank, type Level } from './levels'
import type { Category } from './classifier'

/** Per task type: how many levels your overrides were above (+) or below (-) the automatic choice. */
export type Learned = { v: 1; byCategory: Partial<Record<Category, { sum: number; n: number }>> }

/** Overrides needed for a task type before the controller adjusts it. */
export const MIN_SAMPLES = 3

export function readLearned(value: unknown): Learned {
  if (typeof value !== 'object' || value === null || (value as { v?: unknown }).v !== 1) return { v: 1, byCategory: {} }
  const by = (value as { byCategory?: unknown }).byCategory
  return { v: 1, byCategory: typeof by === 'object' && by !== null ? (by as Learned['byCategory']) : {} }
}

/** Records one correction: you chose `chosen` where the controller chose `auto`. */
export function recordCorrection(learned: Learned, category: Category, auto: Level, chosen: Level): Learned {
  const delta = rank(chosen) - rank(auto)
  const prev = learned.byCategory[category] ?? { sum: 0, n: 0 }
  // Keep the last 20 corrections' weight: older ones fade out.
  const n = Math.min(prev.n, 19)
  const sum = prev.n > 0 ? (prev.sum / prev.n) * n : 0
  return { v: 1, byCategory: { ...learned.byCategory, [category]: { sum: sum + delta, n: n + 1 } } }
}

/** The adjustment in whole levels (-1, 0 or +1) learned for a task type. */
export function learnedShift(learned: Learned, category: Category): number {
  const entry = learned.byCategory[category]
  if (!entry || entry.n < MIN_SAMPLES) return 0
  const avg = entry.sum / entry.n
  if (avg >= 0.5) return 1
  if (avg <= -0.5) return -1
  return 0
}

/** Output tokens (thinking included) per level, from finished tasks. */
export type Usage = { v: 1; byLevel: Partial<Record<Level, { turns: number; output: number }>> }

export function readUsage(value: unknown): Usage {
  if (typeof value !== 'object' || value === null || (value as { v?: unknown }).v !== 1) return { v: 1, byLevel: {} }
  const by = (value as { byLevel?: unknown }).byLevel
  return { v: 1, byLevel: typeof by === 'object' && by !== null ? (by as Usage['byLevel']) : {} }
}

export function recordUsage(usage: Usage, level: Level, outputTokens: number): Usage {
  const prev = usage.byLevel[level] ?? { turns: 0, output: 0 }
  return { v: 1, byLevel: { ...usage.byLevel, [level]: { turns: prev.turns + 1, output: prev.output + outputTokens } } }
}

/** Samples needed at HIGH before a saving is estimated. */
export const MIN_HIGH_SAMPLES = 3

/**
 * The cost overview: average output tokens per task and level, and an
 * estimate of what running every task below HIGH at HIGH would have cost more.
 */
export function usageSummary(usage: Usage): string[] {
  const lines: string[] = []
  const rows = LEVELS.flatMap(l => {
    const e = usage.byLevel[l]
    return e && e.turns > 0 ? [`${l.toUpperCase()} ${e.turns}× ~${Math.round(e.output / e.turns).toLocaleString('en-US')}`] : []
  })
  if (rows.length === 0) return lines
  lines.push(`Output tokens per task (thinking included): ${rows.join(', ')}`)
  const high = usage.byLevel.high
  if (!high || high.turns < MIN_HIGH_SAMPLES) {
    lines.push(`Savings vs. always HIGH: needs ${MIN_HIGH_SAMPLES} tasks at HIGH to estimate`)
    return lines
  }
  const avgHigh = high.output / high.turns
  let saved = 0
  for (const l of ['low', 'medium'] as const) {
    const e = usage.byLevel[l]
    if (e && e.turns > 0) saved += e.turns * avgHigh - e.output
  }
  lines.push(`Savings vs. always HIGH: ~${Math.max(0, Math.round(saved)).toLocaleString('en-US')} output tokens (estimate)`)
  return lines
}
