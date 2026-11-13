// Which effort levels each Claude model family takes, and its API default.
//
// Source: Anthropic's model documentation as bundled with Claude Code 2.1.321
// (claude-api skill, "Thinking & Effort", cached 2026-11-03). The engine stays
// the authority at run time: a model that takes no effort arrives at turn.step
// without `effort`, and the engine silently lowers a level a model lacks. This
// table lets the controller pick the nearest supported level itself (and say
// so) instead of relying on that silent downgrade.
//
// To support a new model: add a row ABOVE any broader pattern it would match.

import { LEVELS, rank, type Level } from './levels'

export type ModelProfile = {
  /** Human-readable family name for the UI. */
  family: string
  /** Levels the model accepts, ascending. Empty: the model takes no effort. */
  levels: readonly Level[]
  /** The API default when no effort is sent; undefined when unknown. */
  apiDefault: Level | undefined
  /** False when the id matched no row and all five levels are assumed. */
  isKnown: boolean
}

type Row = { test: RegExp; family: string; levels: readonly Level[]; apiDefault?: Level }

const ALL = LEVELS
const NO_XHIGH: readonly Level[] = ['low', 'medium', 'high', 'max']
const LOW_TO_HIGH: readonly Level[] = ['low', 'medium', 'high']
const NONE: readonly Level[] = []

const ROWS: readonly Row[] = [
  { test: /fable|mythos/, family: 'Fable/Mythos 5.x', levels: ALL, apiDefault: 'high' },
  { test: /opus-5-5/, family: 'Opus 5.5', levels: ALL, apiDefault: 'medium' },
  { test: /opus-5(?!-\d)/, family: 'Opus 5', levels: ALL, apiDefault: 'high' },
  { test: /opus-4-[78]/, family: 'Opus 4.7/4.8', levels: ALL, apiDefault: 'high' },
  { test: /(opus|sonnet)-4-6/, family: 'Opus/Sonnet 4.6', levels: NO_XHIGH, apiDefault: 'high' },
  { test: /opus-4-5/, family: 'Opus 4.5', levels: LOW_TO_HIGH, apiDefault: 'high' },
  { test: /sonnet-5-5/, family: 'Sonnet 5.5', levels: ALL, apiDefault: 'high' },
  { test: /sonnet-5(?!-\d)/, family: 'Sonnet 5', levels: ALL, apiDefault: 'high' },
  { test: /haiku-5-5/, family: 'Haiku 5.5', levels: ALL, apiDefault: 'medium' },
  {
    test: /haiku-4|sonnet-4-[05]|sonnet-4(?:$|-20)|opus-4-[01]|opus-4(?:$|-20)|claude-3/,
    family: 'ohne Effort',
    levels: NONE,
  },
  // Aliases as Claude Code resolves them to the current generation.
  { test: /^opus$|^best$|^opusplan$/, family: 'Opus (Alias)', levels: ALL, apiDefault: 'medium' },
  { test: /^sonnet$/, family: 'Sonnet (Alias)', levels: ALL, apiDefault: 'high' },
  { test: /^haiku$/, family: 'Haiku (Alias)', levels: ALL, apiDefault: 'medium' },
  { test: /^fable$/, family: 'Fable (Alias)', levels: ALL, apiDefault: 'high' },
]

export function normalizeModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '') // context-window suffix like [1m]
    .replace(/\./g, '-')
    .replace(/^.*?(claude-)/, '$1') // provider prefixes (us.anthropic., anthropic.)
    .trim()
}

export function profileFor(model: string | undefined): ModelProfile {
  const id = normalizeModelId(model ?? '')
  for (const row of ROWS) {
    if (row.test.test(id)) {
      return { family: row.family, levels: row.levels, apiDefault: row.apiDefault, isKnown: true }
    }
  }
  return { family: model ? `unbekannt (${model})` : 'unbekannt', levels: ALL, apiDefault: undefined, isKnown: false }
}

/**
 * The supported level nearest to `wanted`. `prefer` breaks the tie when the
 * exact level is missing: `down` (default, conservative) takes the next lower
 * supported level, `up` the next higher one; either falls back to the other.
 */
export function nearestSupported(
  wanted: Level,
  levels: readonly Level[],
  prefer: 'down' | 'up' = 'down',
): Level | undefined {
  if (levels.length === 0) return undefined
  if (levels.includes(wanted)) return wanted
  const lower = [...levels].filter(l => rank(l) < rank(wanted)).sort((a, b) => rank(b) - rank(a))[0]
  const higher = [...levels].filter(l => rank(l) > rank(wanted)).sort((a, b) => rank(a) - rank(b))[0]
  return prefer === 'up' ? (higher ?? lower) : (lower ?? higher)
}
