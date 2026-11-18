// Your own rules and per-project limits, written as plain text in /config.
// Pure: parsing and matching only, nothing is read or written here.
//
// Rules ("rules" setting), separated by ";" or new lines:
//   /quick=low        a prompt containing "/quick" runs at exactly LOW
//   infra/>=high      a prompt mentioning "infra/" runs at least at HIGH
//   readme<=medium    a prompt mentioning "readme" runs at most at MEDIUM
// Matching is case-insensitive on the prompt text. Several matching rules
// combine: the highest minimum, the lowest maximum, the last exact level.
//
// Project profiles ("projectProfiles" setting), separated by ";" or new lines:
//   playground: max=high
//   payments-api: min=medium max=xhigh
// The text before ":" is matched case-insensitively against the session's
// folder path; the first matching profile replaces min/max for that folder.

import { isLevel, label, maxOf, minOf, type Level } from './levels'

export type Rule = { text: string; op: '=' | '>=' | '<='; level: Level }

export type RuleEffect = { exact?: Level; min?: Level; max?: Level; notes: string[] }

export type ProjectProfile = { match: string; min?: Level; max?: Level }

const RULE = /^(.+?)\s*(>=|<=|=)\s*(low|medium|high|xhigh|max)\s*$/i

function entries(text: string): string[] {
  return text
    .split(/[;\n]/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/** Parses the rules setting; entries that do not parse are reported. */
export function parseRules(text: string): { rules: Rule[]; invalid: string[] } {
  const rules: Rule[] = []
  const invalid: string[] = []
  for (const entry of entries(text)) {
    const m = RULE.exec(entry)
    const level = m?.[3]?.toLowerCase()
    if (m && m[1] && isLevel(level)) rules.push({ text: m[1].trim().toLowerCase(), op: m[2] as Rule['op'], level })
    else invalid.push(entry)
  }
  return { rules, invalid }
}

/** What the rules say about this prompt. */
export function applyRules(prompt: string, rules: readonly Rule[]): RuleEffect {
  const lower = prompt.toLowerCase()
  const effect: RuleEffect = { notes: [] }
  for (const r of rules) {
    if (!lower.includes(r.text)) continue
    if (r.op === '=') effect.exact = r.level
    if (r.op === '>=') effect.min = effect.min ? maxOf(effect.min, r.level) : r.level
    if (r.op === '<=') effect.max = effect.max ? minOf(effect.max, r.level) : r.level
    effect.notes.push(`rule "${r.text}${r.op}${label(r.level)}"`)
  }
  return effect
}

/** Parses the project profiles setting; entries that do not parse are reported. */
export function parseProfiles(text: string): { profiles: ProjectProfile[]; invalid: string[] } {
  const profiles: ProjectProfile[] = []
  const invalid: string[] = []
  for (const entry of entries(text)) {
    const colon = entry.indexOf(':')
    const match = colon > 0 ? entry.slice(0, colon).trim().toLowerCase().replace(/\\/g, '/') : ''
    const profile: ProjectProfile = { match }
    let ok = match.length > 0
    for (const part of (colon > 0 ? entry.slice(colon + 1) : '').trim().split(/\s+/).filter(Boolean)) {
      const m = /^(min|max)=(low|medium|high|xhigh|max)$/i.exec(part)
      const level = m?.[2]?.toLowerCase()
      if (!m || !isLevel(level)) ok = false
      else if (m[1]?.toLowerCase() === 'min') profile.min = level
      else profile.max = level
    }
    if (ok && (profile.min || profile.max)) profiles.push(profile)
    else invalid.push(entry)
  }
  return { profiles, invalid }
}

/** The first profile whose text occurs in the folder path. */
export function profileForFolder(cwd: string, profiles: readonly ProjectProfile[]): ProjectProfile | undefined {
  const path = cwd.toLowerCase().replace(/\\/g, '/')
  return profiles.find(p => path.includes(p.match))
}
