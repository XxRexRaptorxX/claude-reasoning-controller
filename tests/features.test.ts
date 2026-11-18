import { describe, expect, test } from 'claude-code/testing'

import { analyze } from '../hooks/lib/classifier'
import { learnedShift, readLearned, readUsage, recordCorrection, recordUsage, usageSummary } from '../hooks/lib/learning'
import { decide } from '../hooks/lib/policy'
import { applyRules, parseProfiles, parseRules, profileForFolder } from '../hooks/lib/rules'
import { DEFAULTS } from '../hooks/lib/settings'

const HARD_DEBUG = 'Find and fix a hard to reproduce bug in an existing codebase.'
const QUESTION = 'Hi, how does a Java variable work?'
const FEATURE = 'Implement a small new feature in my project.'
const base = { settings: DEFAULTS, model: 'claude-opus-5-5', baseline: 'medium' as const }

describe('rules', () => {
  test('parse exact, minimum and maximum rules; report the rest', () => {
    const { rules, invalid } = parseRules('/quick=low; infra/ >= high\nREADME<=medium; nonsense')
    expect(rules).toEqual([
      { text: '/quick', op: '=', level: 'low' },
      { text: 'infra/', op: '>=', level: 'high' },
      { text: 'readme', op: '<=', level: 'medium' },
    ])
    expect(invalid).toEqual(['nonsense'])
  })

  test('only matching rules apply, case-insensitively', () => {
    const { rules } = parseRules('/quick=low; infra/>=high')
    expect(applyRules('Change infra/main.tf', rules)).toEqual({ min: 'high', notes: ['rule "infra/>=HIGH"'] })
    expect(applyRules('nothing here', rules).notes).toEqual([])
  })

  test('an exact rule decides; a minimum lifts; a maximum caps', () => {
    const { rules } = parseRules('/quick=low; infra/>=high; readme<=low')
    expect(decide({ ...base, analysis: analyze(HARD_DEBUG), ruleEffect: applyRules(`/quick ${HARD_DEBUG}`, rules) }).level).toBe('low')
    expect(decide({ ...base, analysis: analyze(QUESTION), ruleEffect: applyRules(`${QUESTION} infra/`, rules) }).level).toBe('high')
    expect(decide({ ...base, analysis: analyze(FEATURE), ruleEffect: applyRules(`${FEATURE} README`, rules) }).level).toBe('low')
  })
})

describe('project profiles', () => {
  test('parse and match by folder part, Windows paths included', () => {
    const { profiles, invalid } = parseProfiles('playground: max=high; Payments-API: min=medium max=xhigh; broken')
    expect(profiles).toEqual([
      { match: 'playground', max: 'high' },
      { match: 'payments-api', min: 'medium', max: 'xhigh' },
    ])
    expect(invalid).toEqual(['broken'])
    expect(profileForFolder('D:\\Code\\Payments-API\\src', profiles)?.match).toBe('payments-api')
    expect(profileForFolder('/home/me/other', profiles)).toBeUndefined()
  })
})

describe('learning from overrides', () => {
  test('three overrides one level up shift that task type by one level', () => {
    let learned = readLearned(undefined)
    learned = recordCorrection(learned, 'implement', 'medium', 'high')
    learned = recordCorrection(learned, 'implement', 'medium', 'high')
    expect(learnedShift(learned, 'implement')).toBe(0)
    learned = recordCorrection(learned, 'implement', 'medium', 'xhigh')
    expect(learnedShift(learned, 'implement')).toBe(1)
    expect(learnedShift(learned, 'debug')).toBe(0)
    expect(decide({ ...base, analysis: analyze(FEATURE), learnedShift: 1 }).level).toBe('high')
  })

  test('mixed corrections cancel out; nothing but task types and steps is kept', () => {
    let learned = readLearned(undefined)
    for (const chosen of ['high', 'low', 'high', 'low'] as const) learned = recordCorrection(learned, 'debug', 'medium', chosen)
    expect(learnedShift(learned, 'debug')).toBe(0)
    expect(learned).toEqual({ v: 1, byCategory: { debug: { sum: 0, n: 4 } } })
  })

  test('the limits still apply to a learned shift', () => {
    expect(decide({ ...base, settings: { ...DEFAULTS, maxLevel: 'medium' }, analysis: analyze(FEATURE), learnedShift: 1 }).level).toBe('medium')
  })
})

describe('cost overview', () => {
  test('averages per level and an estimate of the saving against HIGH', () => {
    let usage = readUsage(undefined)
    for (let i = 0; i < 3; i++) usage = recordUsage(usage, 'high', 3000)
    usage = recordUsage(usage, 'low', 500)
    usage = recordUsage(usage, 'low', 700)
    const lines = usageSummary(usage)
    expect(lines[0]).toContain('LOW 2× ~600')
    expect(lines[0]).toContain('HIGH 3× ~3,000')
    expect(lines[1]).toContain('~4,800 output tokens')
  })

  test('no estimate without enough tasks at HIGH', () => {
    const usage = recordUsage(readUsage(undefined), 'low', 500)
    expect(usageSummary(usage)[1]).toContain('needs 3 tasks at HIGH')
  })
})
