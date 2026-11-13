// The person's preferences, read from the manifest's userConfig (stored by
// Claude Code in settings.json under pluginConfigs, shown as /config rows).

import { isLevel, rank, type Level } from './levels'

export const MODES = ['auto', 'balanced', 'quality', 'speed', 'manual'] as const
export type Mode = (typeof MODES)[number]

export const PRIORITIES = ['efficiency', 'balanced', 'quality'] as const
export type Priority = (typeof PRIORITIES)[number]

export const MAX_CHOICES = ['medium', 'high', 'xhigh', 'max'] as const
export const MIN_CHOICES = ['low', 'medium', 'high'] as const
export const MANUAL_CHOICES = ['session', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type Settings = {
  mode: Mode
  maxLevel: Level
  minLevel: Level
  priority: Priority
  /** undefined: leave the session's own effort (/effort) untouched. */
  manualLevel: Level | undefined
  autoEscalation: boolean
  showDecision: boolean
  aiClassifier: boolean
}

export const DEFAULTS: Settings = {
  mode: 'auto',
  maxLevel: 'max',
  minLevel: 'low',
  priority: 'balanced',
  manualLevel: undefined,
  autoEscalation: true,
  showDecision: true,
  aiClassifier: false,
}

/** The config field names, as `/config` and `$.config.set` key them. */
export const FIELDS = [
  'mode',
  'maxLevel',
  'minLevel',
  'priority',
  'manualLevel',
  'autoEscalation',
  'showDecision',
  'aiClassifier',
] as const
export type Field = (typeof FIELDS)[number]

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
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
    priority: pick(o['priority'], PRIORITIES, 'balanced'),
    manualLevel: isLevel(manual) ? manual : undefined,
    autoEscalation: bool(o['autoEscalation'], DEFAULTS.autoEscalation),
    showDecision: bool(o['showDecision'], DEFAULTS.showDecision),
    aiClassifier: bool(o['aiClassifier'], DEFAULTS.aiClassifier),
  }
}

export const MODE_LABEL: Record<Mode, string> = {
  auto: 'AUTO',
  balanced: 'BALANCED',
  quality: 'QUALITY FIRST',
  speed: 'SPEED FIRST',
  manual: 'MANUAL',
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  efficiency: 'Maximale Effizienz',
  balanced: 'Ausgewogen',
  quality: 'Maximale Qualität',
}
