// User-facing text: the transparency notice, the band line, /reasoning output.
// Only task traits and settings appear here, never the prompt itself.

import type { ReasoningDecisionView, ReasoningLevel } from '../../types'
import { isLevel, label, LEVELS, type Level } from './levels'
import { MODE_LABEL, MODES, PRIORITIES, PRIORITY_LABEL, type Mode, type Settings } from './settings'
import type { Decision } from './policy'

export function toView(turnId: string, d: Decision): ReasoningDecisionView {
  return {
    turnId,
    ...(d.level ? { level: d.level } : {}),
    ...(d.requested ? { requested: d.requested } : {}),
    ...(d.baseline ? { baseline: d.baseline } : {}),
    source: d.source,
    mode: d.mode,
    categoryLabel: d.categoryLabel,
    reasons: d.reasons.slice(0, 4),
    notes: d.notes.slice(0, 4),
    family: d.family,
    score: d.score,
    escalated: d.escalated,
  }
}

function modeLabel(mode: string): string {
  return (MODES as readonly string[]).includes(mode) ? MODE_LABEL[mode as Mode] : mode.toUpperCase()
}

/** The notice shown before a task (transparency setting). */
export function decisionNotice(v: ReasoningDecisionView): string {
  if (v.source === 'unsupported') {
    return `Reasoning-Controller: ${v.family} nimmt keine Effort-Stufe an, die Anfrage bleibt unverändert.`
  }
  const head =
    v.source === 'override'
      ? `${modeLabel(v.mode)} · manuelle Überschreibung`
      : v.source === 'keys'
        ? `${modeLabel(v.mode)} · Tastatur-Wahl (effort-cycle)`
      : v.source === 'session'
        ? 'MANUAL · Sitzungsstufe (/effort)'
        : modeLabel(v.mode) + ' MODE'
  const level = v.level ?? v.baseline
  const lines = [
    head,
    `Erkannte Aufgabe: ${v.categoryLabel}`,
    `Ausgewählte Reasoning-Stufe: ${level ? label(level) : 'unverändert'}` +
      (v.baseline && v.level && v.baseline !== v.level ? ` (Sitzungsstandard: ${label(v.baseline)})` : ''),
    `Begründung: ${v.reasons.join('; ')}.`,
  ]
  if (v.notes.length > 0) lines.push(`Hinweis: ${v.notes.join('; ')}.`)
  return lines.join('\n')
}

export function escalationNotice(from: Level | undefined, to: Level, reason: string): string {
  return `Reasoning-Controller: Eskalation ${from ? label(from) + ' → ' : ''}${label(to)} (${reason}).`
}

export type BandParts = { mode: string; level: string; detail: string; limit: string }

/** The one-line summary above the prompt. */
export function bandParts(v: ReasoningDecisionView | null, s: Settings, pending: ReasoningLevel | null): BandParts {
  const mode = MODE_LABEL[s.mode]
  const limit = `Max Limit · ${label(s.maxLevel)}${s.minLevel !== 'low' ? ` | Min Limit · ${label(s.minLevel)}` : ''}`
  let level: string
  let detail: string
  if (v === null) {
    level = s.mode === 'manual' ? (s.manualLevel ? label(s.manualLevel) : '/effort') : 'bereit'
    detail = s.mode === 'manual' ? 'feste Stufe' : 'wählt beim nächsten Auftrag'
  } else if (v.source === 'unsupported') {
    level = '—'
    detail = `${v.family}: kein Effort`
  } else {
    const shown = v.level ?? v.baseline
    level = (shown ? label(shown) : '/effort') + (v.escalated ? ' ↑' : '')
    detail = `${v.categoryLabel}: ${v.escalationReason ?? v.reasons[0] ?? ''}`
  }
  if (pending !== null) detail = `nächster Auftrag: ${label(pending)} (manuell) · ` + detail
  return { mode, level, detail, limit }
}

export function truncate(text: string, max: number): string {
  if (max <= 1) return ''
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

export function statusText(v: ReasoningDecisionView | null, s: Settings, pending: ReasoningLevel | null, stats: Stats): string {
  const lines = [
    `Modus: ${MODE_LABEL[s.mode]} · Priorität: ${PRIORITY_LABEL[s.priority]} · Bereich: ${label(s.minLevel)}–${label(s.maxLevel)}` +
      (s.mode === 'manual' ? ` · manuelle Stufe: ${s.manualLevel ? label(s.manualLevel) : 'Sitzung (/effort)'}` : ''),
    `Eskalation: ${s.autoEscalation ? 'an' : 'aus'} · Anzeige: ${s.showDecision ? 'an' : 'aus'} · KI-Klassifizierung: ${s.aiClassifier ? 'an' : 'aus'}`,
  ]
  if (pending !== null) lines.push(`Nächster Auftrag: ${label(pending)} (manuelle Überschreibung)`)
  if (v !== null) lines.push('Letzte Entscheidung:\n' + decisionNotice(v))
  if (stats.total > 0) {
    const dist = LEVELS.map(l => `${label(l)} ${stats.byLevel[l] ?? 0}`).join(', ')
    lines.push(`Statistik (${stats.total} Aufträge): ${dist}; Eskalationen ${stats.escalations}, Überschreibungen ${stats.overrides}`)
  }
  return lines.join('\n')
}

export const HELP = [
  '/reasoning                    Status anzeigen',
  '/reasoning <stufe>            Stufe für den nächsten Auftrag (low|medium|high|xhigh|max)',
  '/reasoning auto               Überschreibung verwerfen, automatisch wählen',
  '/reasoning mode <modus>       auto|balanced|quality|speed|manual',
  '/reasoning max-level <stufe>  medium|high|xhigh|max (Obergrenze)',
  '/reasoning min-level <stufe>  low|medium|high (Untergrenze)',
  '/reasoning priority <wert>    efficiency|balanced|quality',
  '/reasoning manual <stufe>     session|low|medium|high|xhigh|max (Stufe im Modus manual)',
  '/reasoning escalation on|off · display on|off · ai on|off',
  '/reasoning settings           Einstellungsfenster öffnen',
  '/reasoning reset-stats        Statistik löschen',
].join('\n')

// Anonymous decision metadata kept across sessions ($.store): counts only.
export type Stats = {
  v: 1
  total: number
  byLevel: Partial<Record<Level, number>>
  bySource: Record<string, number>
  escalations: number
  overrides: number
}

export function emptyStats(): Stats {
  return { v: 1, total: 0, byLevel: {}, bySource: {}, escalations: 0, overrides: 0 }
}

export function readStats(value: unknown): Stats {
  if (typeof value !== 'object' || value === null || (value as { v?: unknown }).v !== 1) return emptyStats()
  const v = value as Partial<Stats>
  return {
    v: 1,
    total: typeof v.total === 'number' ? v.total : 0,
    byLevel: typeof v.byLevel === 'object' && v.byLevel !== null ? v.byLevel : {},
    bySource: typeof v.bySource === 'object' && v.bySource !== null ? v.bySource : {},
    escalations: typeof v.escalations === 'number' ? v.escalations : 0,
    overrides: typeof v.overrides === 'number' ? v.overrides : 0,
  }
}

export function countDecision(stats: Stats, d: Decision): Stats {
  const byLevel = { ...stats.byLevel }
  if (d.level) byLevel[d.level] = (byLevel[d.level] ?? 0) + 1
  return {
    ...stats,
    total: stats.total + 1,
    byLevel,
    bySource: { ...stats.bySource, [d.source]: (stats.bySource[d.source] ?? 0) + 1 },
    overrides: stats.overrides + (d.source === 'override' ? 1 : 0),
  }
}

// ---- /reasoning argument parsing (pure) ----

export type CommandAction =
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'clear' }
  | { kind: 'override'; level: Level; prompt: string }
  | { kind: 'choice'; field: 'mode' | 'maxLevel' | 'minLevel' | 'priority' | 'manualLevel'; value: string }
  | { kind: 'toggle'; field: 'autoEscalation' | 'showDecision' | 'aiClassifier'; value: boolean }
  | { kind: 'settings' }
  | { kind: 'reset-stats' }
  | { kind: 'error'; message: string }

const CHOICE_FIELDS: Record<string, { field: 'mode' | 'maxLevel' | 'minLevel' | 'priority' | 'manualLevel'; allowed: readonly string[] }> = {
  mode: { field: 'mode', allowed: MODES },
  'max-level': { field: 'maxLevel', allowed: ['medium', 'high', 'xhigh', 'max'] },
  limit: { field: 'maxLevel', allowed: ['medium', 'high', 'xhigh', 'max'] },
  'min-level': { field: 'minLevel', allowed: ['low', 'medium', 'high'] },
  floor: { field: 'minLevel', allowed: ['low', 'medium', 'high'] },
  priority: { field: 'priority', allowed: PRIORITIES },
  manual: { field: 'manualLevel', allowed: ['session', ...LEVELS] },
}

const TOGGLES: Record<string, 'autoEscalation' | 'showDecision' | 'aiClassifier'> = {
  escalation: 'autoEscalation',
  display: 'showDecision',
  transparency: 'showDecision',
  ai: 'aiClassifier',
}

export function parseCommand(args: string): CommandAction {
  const trimmed = args.trim()
  if (trimmed === '' || trimmed === 'status') return { kind: 'status' }
  const [head = '', ...rest] = trimmed.split(/\s+/)
  const word = head.toLowerCase()
  const tail = trimmed.slice(head.length).trim()
  if (word === 'help' || word === 'hilfe' || word === '?') return { kind: 'help' }
  if (word === 'auto') return { kind: 'clear' }
  if (word === 'settings' || word === 'einstellungen') return { kind: 'settings' }
  if (word === 'reset-stats') return { kind: 'reset-stats' }
  if (isLevel(word)) return { kind: 'override', level: word, prompt: tail }
  const entry = CHOICE_FIELDS[word]
  if (entry) {
    const value = (rest[0] ?? '').toLowerCase()
    if (!entry.allowed.includes(value)) {
      return { kind: 'error', message: `Erlaubt für ${word}: ${entry.allowed.join(', ')}` }
    }
    return { kind: 'choice', field: entry.field, value }
  }
  const toggle = TOGGLES[word]
  if (toggle) {
    const value = (rest[0] ?? '').toLowerCase()
    if (value !== 'on' && value !== 'off' && value !== 'an' && value !== 'aus') {
      return { kind: 'error', message: `Erlaubt für ${word}: on, off` }
    }
    return { kind: 'toggle', field: toggle, value: value === 'on' || value === 'an' }
  }
  return { kind: 'error', message: `Unbekanntes Argument "${head}".\n${HELP}` }
}
