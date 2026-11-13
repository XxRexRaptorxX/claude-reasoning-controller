// Effort levels as the engine (turn.step / ModelEffort) names them, in order.

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type Level = (typeof LEVELS)[number]

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
}

export function rank(level: Level): number {
  return LEVELS.indexOf(level)
}

export function atRank(r: number): Level {
  const i = Math.max(0, Math.min(LEVELS.length - 1, Math.round(r)))
  return LEVELS[i] ?? 'medium'
}

export function clampLevel(level: Level, min: Level, max: Level): Level {
  const lo = Math.min(rank(min), rank(max))
  const hi = Math.max(rank(min), rank(max))
  return atRank(Math.max(lo, Math.min(hi, rank(level))))
}

export function maxOf(a: Level, b: Level): Level {
  return rank(a) >= rank(b) ? a : b
}

export function minOf(a: Level, b: Level): Level {
  return rank(a) <= rank(b) ? a : b
}

export function step(level: Level, delta: number): Level {
  return atRank(rank(level) + delta)
}

export function label(level: Level): string {
  return level.toUpperCase()
}
