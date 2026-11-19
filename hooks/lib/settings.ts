// The person's preferences, read from the manifest's userConfig (stored by
// Claude Code in settings.json under pluginConfigs, shown as /config rows).

import { isLevel, rank, type Level } from './levels'

export const MODES = ['auto', 'speed', 'quality', 'manual'] as const
export type Mode = (typeof MODES)[number]


export const MAX_CHOICES = ['medium', 'high', 'xhigh', 'max'] as const
export const MIN_CHOICES = ['low', 'medium', 'high'] as const
export const MANUAL_CHOICES = ['session', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** When the small model is asked for the level: never, for unclear tasks, for every task. */
export const AI_MODES = ['off', 'unclear', 'always'] as const
export type AiMode = (typeof AI_MODES)[number]

export type Settings = {
  mode: Mode
  maxLevel: Level
  minLevel: Level
  /** undefined: leave the session's own effort (/effort) untouched. */
  manualLevel: Level | undefined
  autoEscalation: boolean
  showDecision: boolean
  aiClassification: AiMode
  /** The line above the prompt. */
  showStatusLine: boolean
  /** Your own rules, e.g. "/quick=low; infra/>=high" (see rules.ts). */
  rules: string
  /** Adjust per task type when you often override the level for it. */
  learnFromOverrides: boolean
  /** Limits per project folder, e.g. "playground: max=high; api: min=medium". */
  projectProfiles: string
}

export const DEFAULTS: Settings = {
  mode: 'auto',
  maxLevel: 'max',
  minLevel: 'low',
  manualLevel: undefined,
  autoEscalation: true,
  showDecision: true,
  aiClassification: 'unclear',
  showStatusLine: true,
  rules: '',
  learnFromOverrides: true,
  projectProfiles: '',
}

/** The config field names, as `/config` and `$.config.set` key them. */
export const FIELDS = [
  'mode',
  'maxLevel',
  'minLevel',
  'manualLevel',
  'autoEscalation',
  'showDecision',
  'aiClassification',
  'showStatusLine',
  'rules',
  'learnFromOverrides',
  'projectProfiles',
] as const
export type Field = (typeof FIELDS)[number]

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 2000) : ''
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function parseSettings(options: Readonly<Record<string, unknown>> | undefined): Settings {
  const o = options ?? {}
  const maxLevel = pick(o['maxLevel'], MAX_CHOICES, 'max')
  let minLevel: Level = pick(o['minLevel'], MIN_CHOICES, 'low')
  // A floor above the ceiling would be contradictory: the ceiling wins.
  if (rank(minLevel) > rank(maxLevel)) minLevel = maxLevel
  const manual = pick(o['manualLevel'], MANUAL_CHOICES, 'session')
  return {
    mode: pick(o['mode'], MODES, 'auto'),
    maxLevel,
    minLevel,
    manualLevel: isLevel(manual) ? manual : undefined,
    autoEscalation: bool(o['autoEscalation'], DEFAULTS.autoEscalation),
    showDecision: bool(o['showDecision'], DEFAULTS.showDecision),
    aiClassification: pick(o['aiClassification'], AI_MODES, 'unclear'),
    showStatusLine: bool(o['showStatusLine'], DEFAULTS.showStatusLine),
    rules: text(o['rules']),
    learnFromOverrides: bool(o['learnFromOverrides'], DEFAULTS.learnFromOverrides),
    projectProfiles: text(o['projectProfiles']),
  }
}

export const MODE_LABEL: Record<Mode, string> = {
  auto: 'AUTO',
  quality: 'QUALITY',
  speed: 'SPEED',
  manual: 'MANUAL',
}
