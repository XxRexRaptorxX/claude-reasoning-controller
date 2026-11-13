import { describe, expect, test } from 'claude-code/testing'

import { analyze } from '../hooks/lib/classifier'
import { parseCommand } from '../hooks/lib/format'
import { nearestSupported, profileFor } from '../hooks/lib/models'
import { decide, escalate } from '../hooks/lib/policy'
import { DEFAULTS, parseSettings } from '../hooks/lib/settings'

const HARD_DEBUG = 'Finde und behebe einen schwer reproduzierbaren Fehler in einer bestehenden Codebasis.'
const REFACTOR = 'Analysiere die Architektur meines gesamten Projekts und plane ein umfangreiches Refactoring.'
const SECURITY = 'Führe eine tiefgehende Sicherheitsanalyse einer komplexen Implementierung durch.'
const QUESTION = 'Hallo, wie funktioniert eine Java-Variable?'
const FEATURE = 'Implementiere eine überschaubare neue Funktion in meinem Projekt.'

const run = (text: string, options: Record<string, unknown> = {}, model = 'claude-opus-5-5', baseline: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined = 'medium') =>
  decide({ analysis: analyze(text), settings: parseSettings(options), model, baseline })

describe('manual override', () => {
  test('/reasoning <level> wins over the analysis and over min/max', () => {
    const d = decide({
      analysis: analyze(QUESTION),
      settings: parseSettings({ maxLevel: 'medium' }),
      model: 'claude-opus-5-5',
      baseline: 'medium',
      override: 'max',
    })
    expect(d.level).toBe('max')
    expect(d.source).toBe('override')
  })

  test('an override is still held to the model: XHIGH on Opus 4.6 becomes HIGH', () => {
    const d = decide({ analysis: analyze(QUESTION), settings: DEFAULTS, model: 'claude-opus-4-6', baseline: 'high', override: 'xhigh' })
    expect(d.level).toBe('high')
    expect(d.notes.join(' ')).toContain('nicht unterstützt')
  })

  test('the command parser reads levels, modes and toggles', () => {
    expect(parseCommand('high')).toEqual({ kind: 'override', level: 'high', prompt: '' })
    expect(parseCommand('max Beweise, dass …')).toEqual({ kind: 'override', level: 'max', prompt: 'Beweise, dass …' })
    expect(parseCommand('auto')).toEqual({ kind: 'clear' })
    expect(parseCommand('mode quality')).toEqual({ kind: 'set', field: 'mode', value: 'quality' })
    expect(parseCommand('max xhigh')).toEqual({ kind: 'override', level: 'max', prompt: 'xhigh' })
    expect(parseCommand('max-level xhigh')).toEqual({ kind: 'set', field: 'maxLevel', value: 'xhigh' })
    expect(parseCommand('min-level medium')).toEqual({ kind: 'set', field: 'minLevel', value: 'medium' })
    expect(parseCommand('escalation off')).toEqual({ kind: 'toggle', field: 'autoEscalation', value: false })
    expect(parseCommand('mode turbo').kind).toBe('error')
    expect(parseCommand('').kind).toBe('status')
  })
})

describe('unsupported levels and model families', () => {
  test('profiles per family', () => {
    expect(profileFor('claude-opus-5-5').apiDefault).toBe('medium')
    expect(profileFor('claude-sonnet-5-5').levels).toContain('xhigh')
    expect(profileFor('claude-opus-4-6').levels).not.toContain('xhigh')
    expect(profileFor('claude-opus-4-5-20251101').levels).toEqual(['low', 'medium', 'high'])
    expect(profileFor('claude-haiku-4-5').levels).toEqual([])
    expect(profileFor('claude-sonnet-4-5-20250929').levels).toEqual([])
    expect(profileFor('us.anthropic.claude-opus-5-5[1m]').family).toBe('Opus 5.5')
    expect(profileFor('claude-future-9').isKnown).toBe(false)
  })

  test('nearest supported level: down by default, up on request', () => {
    expect(nearestSupported('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high')
    expect(nearestSupported('xhigh', ['low', 'medium', 'high', 'max'], 'up')).toBe('max')
    expect(nearestSupported('max', ['low', 'medium', 'high'])).toBe('high')
    expect(nearestSupported('high', [])).toBeUndefined()
  })

  test('XHIGH work on Opus 4.6 runs at HIGH; on Opus 4.5 MAX work runs at HIGH', () => {
    expect(run(REFACTOR, {}, 'claude-opus-4-6', 'high').level).toBe('high')
    expect(run(SECURITY, {}, 'claude-opus-4-5', 'high').level).toBe('high')
  })

  test('QUALITY FIRST rounds a missing level up within the maximum', () => {
    expect(run(REFACTOR, { mode: 'quality' }, 'claude-opus-4-6', 'high').level).toBe('max')
  })

  test('a model without effort is left untouched', () => {
    const d = run(HARD_DEBUG, {}, 'claude-haiku-4-5', undefined)
    expect(d.level).toBeUndefined()
    expect(d.source).toBe('unsupported')
  })

  test('the same task on Sonnet 5.5 and Fable 5.2 gets the same level', () => {
    expect(run(HARD_DEBUG, {}, 'claude-sonnet-5-5', 'high').level).toBe(run(HARD_DEBUG, {}, 'claude-fable-5-2', 'high').level)
  })
})

describe('user profiles', () => {
  test('maximum level: never MAX when capped at XHIGH or HIGH', () => {
    expect(run(SECURITY, { maxLevel: 'xhigh' }).level).toBe('xhigh')
    expect(run(SECURITY, { maxLevel: 'high' }).level).toBe('high')
  })

  test('minimum level: simple tasks do not go below MEDIUM', () => {
    expect(run(QUESTION, { minLevel: 'medium' }).level).toBe('medium')
  })

  test('SPEED FIRST stays at HIGH or below', () => {
    expect(run(SECURITY, { mode: 'speed' }).level).toBe('high')
    expect(run(FEATURE, { mode: 'speed' }).level).toBe('low')
  })

  test('BALANCED never uses MAX', () => {
    expect(run(SECURITY, { mode: 'balanced' }).level).toBe('xhigh')
  })

  test('QUALITY FIRST lifts simple work to at least MEDIUM', () => {
    expect(run(QUESTION, { mode: 'quality' }).level).toBe('medium')
    expect(run(HARD_DEBUG, { mode: 'quality' }).level).toBe('xhigh')
  })

  test('the priority slider moves AUTO', () => {
    expect(run(HARD_DEBUG, { priority: 'efficiency' }).level).toBe('high')
    expect(run(FEATURE, { priority: 'efficiency' }).level).toBe('low')
    expect(run(FEATURE, { priority: 'quality' }).level).toBe('high')
    expect(run(SECURITY, { priority: 'efficiency' }).level).not.toBe('max')
  })

  test('MANUAL with a fixed level ignores the analysis', () => {
    expect(run(SECURITY, { mode: 'manual', manualLevel: 'low' }).level).toBe('low')
  })

  test('MANUAL with "session" leaves /effort untouched', () => {
    const d = run(SECURITY, { mode: 'manual', manualLevel: 'session' })
    expect(d.level).toBeUndefined()
    expect(d.source).toBe('session')
  })
})

describe('stability', () => {
  test('a close call keeps the previous level', () => {
    // FEATURE scores 1.9: MEDIUM, 0.4 above the LOW|MEDIUM boundary.
    const d = decide({
      analysis: analyze(FEATURE),
      settings: DEFAULTS,
      model: 'claude-opus-5-5',
      baseline: 'medium',
      previous: { level: 'low', score: 0, source: 'auto' },
    })
    expect(d.level).toBe('low')
  })

  test('a long conversation is not stepped down by a single level', () => {
    const d = decide({
      analysis: analyze(FEATURE),
      settings: DEFAULTS,
      model: 'claude-opus-5-5',
      baseline: 'medium',
      previous: { level: 'high', score: 5, source: 'auto' },
      messageCount: 80,
    })
    expect(d.level).toBe('high')
  })

  test('a clear change still switches', () => {
    const d = decide({
      analysis: analyze(QUESTION),
      settings: DEFAULTS,
      model: 'claude-opus-5-5',
      baseline: 'medium',
      previous: { level: 'xhigh', score: 8, source: 'auto' },
    })
    expect(d.level).toBe('low')
  })

  test('uncertain prompts use the session level, not the maximum', () => {
    const d = run('Mach das hier mal.', {}, 'claude-opus-5-5', 'medium')
    expect(d.level).toBe('medium')
    expect(d.source).toBe('fallback')
  })
})

describe('automatic escalation', () => {
  test('escalates one supported level, within the maximum', () => {
    const d = run(HARD_DEBUG)
    expect(d.level).toBe('high')
    expect(escalate(d, DEFAULTS)).toBe('xhigh')
    expect(escalate({ ...d, level: 'xhigh' }, parseSettings({ maxLevel: 'xhigh' }))).toBeUndefined()
  })

  test('skips levels the model lacks', () => {
    const d = run(HARD_DEBUG, {}, 'claude-opus-4-6', 'high')
    expect(d.level).toBe('high')
    expect(escalate(d, DEFAULTS)).toBe('max')
  })

  test('never second-guesses a manual choice', () => {
    const d = decide({ analysis: analyze(QUESTION), settings: DEFAULTS, model: 'claude-opus-5-5', baseline: 'medium', override: 'low' })
    expect(escalate(d, DEFAULTS)).toBeUndefined()
  })
})
