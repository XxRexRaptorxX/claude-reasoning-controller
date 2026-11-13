import { describe, expect, test } from 'claude-code/testing'

import { analyze } from '../hooks/lib/classifier'
import { decide } from '../hooks/lib/policy'
import { DEFAULTS, parseSettings, type Settings } from '../hooks/lib/settings'
import type { Level } from '../hooks/lib/levels'

// Opus 5.5: all five levels, API default MEDIUM (the session's level when the
// person set nothing).
const MODEL = 'claude-opus-5-5'
const BASELINE: Level = 'medium'

function levelFor(text: string, settings: Settings = DEFAULTS, model = MODEL, baseline: Level = BASELINE): Level | undefined {
  return decide({ analysis: analyze(text), settings, model, baseline }).level
}

describe('the eight reference tasks (default settings, Opus 5.5)', () => {
  test('1: a basic Java question is LOW', () => {
    expect(levelFor('Hallo, wie funktioniert eine Java-Variable?')).toBe('low')
  })

  test('2: renaming a variable is LOW', () => {
    expect(levelFor('Benenne diese Variable um.')).toBe('low')
  })

  test('3: a manageable new feature is MEDIUM', () => {
    expect(levelFor('Implementiere eine überschaubare neue Funktion in meinem Projekt.')).toBe('medium')
  })

  test('4: a hard-to-reproduce bug in an existing codebase is HIGH or above', () => {
    const level = levelFor('Finde und behebe einen schwer reproduzierbaren Fehler in einer bestehenden Codebasis.')
    expect(['high', 'xhigh', 'max']).toContain(level)
    expect(analyze('Finde und behebe einen schwer reproduzierbaren Fehler in einer bestehenden Codebasis.').categoryLabel).toBe(
      'Komplexes Debugging',
    )
  })

  test('5: whole-project architecture analysis plus large refactoring plan is XHIGH', () => {
    expect(levelFor('Analysiere die Architektur meines gesamten Projekts und plane ein umfangreiches Refactoring.')).toBe('xhigh')
  })

  test('6: an in-depth security analysis of a complex implementation is MAX', () => {
    expect(levelFor('Führe eine tiefgehende Sicherheitsanalyse einer komplexen Implementierung durch.')).toBe('max')
  })

  test('7: a simple but very long list is not raised for its size', () => {
    expect(levelFor('Erstelle eine einfache, aber sehr umfangreiche Liste.')).toBe('low')
  })

  test('8: a short but mathematically hard problem gets high effort', () => {
    const level = levelFor('Löse ein kurzes, aber mathematisch schwieriges Problem.')
    expect(['high', 'xhigh', 'max']).toContain(level)
  })
})

describe('no keyword triggers', () => {
  test('the word "komplex" alone does not raise to MAX', () => {
    const a = analyze('Das ist komplex.')
    expect(a.confidence).toBeLessThan(0.5)
    const level = levelFor('Das ist komplex.')
    expect(level).not.toBe('max')
    expect(level).not.toBe('xhigh')
  })

  test('"komplex" in a simple question stays low or medium', () => {
    expect(['low', 'medium']).toContain(levelFor('Was bedeutet das Wort komplex?'))
  })

  test('a plain security check is below MAX; the in-depth one reaches it', () => {
    expect(levelFor('Prüfe diese Funktion auf Sicherheitslücken.')).not.toBe('max')
  })

  test('a code block with a stack trace counts as debugging', () => {
    const a = analyze('Was ist hier los?\n```\nException in thread "main" java.lang.NullPointerException\n  at com.x.Main.run(Main.java:12)\n```')
    expect(a.category).toBe('debug')
  })

  test('many referenced files widen the scope', () => {
    const files = 'a.ts b.ts c.ts d.ts e.ts f.ts'
    expect(analyze(`Passe die Fehlerbehandlung in ${files} an.`).dims.scope).toBeGreaterThan(
      analyze('Passe die Fehlerbehandlung in a.ts an.').dims.scope,
    )
  })

  test('the analysis never carries the prompt text', () => {
    const secret = 'Implementiere die Funktion geheimnis42 in projekt-x.'
    const a = analyze(secret)
    expect(JSON.stringify(a)).not.toContain('geheimnis42')
  })
})

describe('continuations', () => {
  test('a short follow-up keeps the previous level', () => {
    const a = analyze('ja, mach weiter')
    expect(a.isContinuation).toBe(true)
    const d = decide({
      analysis: a,
      settings: DEFAULTS,
      model: MODEL,
      baseline: BASELINE,
      previous: { level: 'xhigh', score: 8, source: 'auto' },
    })
    expect(d.level).toBe('xhigh')
    expect(d.source).toBe('continuation')
  })

  test('without a previous decision a follow-up uses the session level', () => {
    expect(levelFor('ok')).toBe(BASELINE)
  })
})

describe('settings are parsed defensively', () => {
  test('unknown values fall back to the defaults', () => {
    const s = parseSettings({ mode: 'turbo', maxLevel: 'ultra', autoEscalation: 'yes' })
    expect(s.mode).toBe('auto')
    expect(s.maxLevel).toBe('max')
    expect(s.autoEscalation).toBe(true)
  })

  test('a minimum above the maximum is lowered to the maximum', () => {
    const s = parseSettings({ minLevel: 'high', maxLevel: 'medium' })
    expect(s.minLevel).toBe('medium')
  })

  test('manualLevel "session" means: leave /effort alone', () => {
    expect(parseSettings({ manualLevel: 'session' }).manualLevel).toBeUndefined()
    expect(parseSettings({ manualLevel: 'high' }).manualLevel).toBe('high')
  })
})
