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
      'Complex debugging',
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

describe('the eight reference tasks in English (default settings, Opus 5.5)', () => {
  test('1: a basic Java question is LOW', () => {
    expect(levelFor('Hi, how does a Java variable work?')).toBe('low')
  })

  test('2: renaming a variable is LOW', () => {
    expect(levelFor('Rename this variable.')).toBe('low')
  })

  test('3: a manageable new feature is MEDIUM', () => {
    expect(levelFor('Implement a small new feature in my project.')).toBe('medium')
  })

  test('4: a hard-to-reproduce bug in an existing codebase is HIGH or above', () => {
    expect(['high', 'xhigh', 'max']).toContain(levelFor('Find and fix a hard to reproduce bug in an existing codebase.'))
  })

  test('5: whole-project architecture analysis plus large refactoring plan is XHIGH', () => {
    expect(levelFor('Analyze the architecture of my entire project and plan an extensive refactoring.')).toBe('xhigh')
  })

  test('6: an in-depth security analysis of a complex implementation is MAX', () => {
    expect(levelFor('Perform an in-depth security analysis of a complex implementation.')).toBe('max')
  })

  test('7: a simple but very long list is not raised for its size', () => {
    expect(levelFor('Create a simple but very extensive list.')).toBe('low')
  })

  test('8: a short but mathematically hard problem gets high effort', () => {
    expect(['high', 'xhigh', 'max']).toContain(levelFor('Solve a short but mathematically difficult problem.'))
  })
})

// The same eight reference tasks in more languages. Each row: the prompts
// for tasks 1–8, in order.
const TRANSLATIONS: Record<string, readonly string[]> = {
  Spanish: [
    'Hola, ¿cómo funciona una variable en Java?',
    'Renombra esta variable.',
    'Implementa una pequeña función nueva en mi proyecto.',
    'Encuentra y corrige un error difícil de reproducir en una base de código existente.',
    'Analiza la arquitectura de todo mi proyecto y planifica una refactorización extensa.',
    'Realiza un análisis de seguridad a fondo de una implementación compleja.',
    'Crea una lista sencilla pero muy extensa.',
    'Resuelve un problema corto pero matemáticamente difícil.',
  ],
  French: [
    'Bonjour, comment fonctionne une variable Java ?',
    'Renomme cette variable.',
    'Implémente une petite nouvelle fonction dans mon projet.',
    'Trouve et corrige un bug difficile à reproduire dans une base de code existante.',
    "Analyse l'architecture de tout mon projet et planifie un vaste refactoring.",
    "Effectue une analyse de sécurité approfondie d'une implémentation complexe.",
    'Crée une liste simple mais très longue.',
    'Résous un problème court mais mathématiquement difficile.',
  ],
  Russian: [
    'Привет, как работает переменная в Java?',
    'Переименуй эту переменную.',
    'Реализуй небольшую новую функцию в моём проекте.',
    'Найди и исправь трудно воспроизводимую ошибку в существующей кодовой базе.',
    'Проанализируй архитектуру всего моего проекта и спланируй масштабный рефакторинг.',
    'Проведи глубокий анализ безопасности сложной реализации.',
    'Составь простой, но очень длинный список.',
    'Реши короткую, но математически сложную задачу.',
  ],
  Chinese: [
    '你好，Java 变量是如何工作的？',
    '重命名这个变量。',
    '在我的项目中实现一个小的新功能。',
    '在现有代码库中找到并修复一个难以复现的错误。',
    '分析我整个项目的架构，并规划一次大规模重构。',
    '对一个复杂的实现进行深入的安全分析。',
    '创建一个简单但非常长的列表。',
    '解决一个简短但数学上很难的问题。',
  ],
  Japanese: [
    'こんにちは、Javaの変数はどのように動作しますか？',
    'この変数の名前を変更して。',
    '私のプロジェクトに小さな新機能を実装して。',
    '既存のコードベースで再現しにくいバグを見つけて修正して。',
    'プロジェクト全体のアーキテクチャを分析して、大規模なリファクタリングを計画して。',
    '複雑な実装について徹底的なセキュリティ分析を行って。',
    'シンプルだけどとても長いリストを作って。',
    '短いけれど数学的に難しい問題を解いて。',
  ],
}

const EXPECTED: readonly (readonly string[])[] = [
  ['low'],
  ['low'],
  ['medium'],
  ['high', 'xhigh', 'max'],
  ['xhigh'],
  ['max'],
  ['low'],
  ['high', 'xhigh', 'max'],
]

for (const [language, prompts] of Object.entries(TRANSLATIONS)) {
  describe(`the eight reference tasks in ${language}`, () => {
    prompts.forEach((prompt, i) => {
      test(`${i + 1}: ${prompt}`, () => {
        expect(EXPECTED[i]).toContain(levelFor(prompt))
      })
    })
  })
}

describe('languages without a vocabulary', () => {
  test('an unclear prompt in another language uses the session level, not the maximum', () => {
    const d = decide({ analysis: analyze('Korjaa tämä virhe, kiitos.'), settings: DEFAULTS, model: MODEL, baseline: BASELINE })
    expect(d.level).toBe(BASELINE)
  })

  test('language-neutral signals still count: a stack trace means debugging', () => {
    const a = analyze('Mikä tässä on vialla?\n```\nTraceback (most recent call last):\n  File "app.py", line 3\n```')
    expect(a.category).toBe('debug')
  })
})

// Spot checks for the other languages with a vocabulary: a question, a rename
// and a hard bug.
const SPOT_CHECKS: Record<string, readonly [string, string, string]> = {
  Portuguese: [
    'Olá, como funciona uma variável em Java?',
    'Renomeie esta variável.',
    'Encontre e corrija um erro difícil de reproduzir em uma base de código existente.',
  ],
  Italian: [
    'Ciao, come funziona una variabile in Java?',
    'Rinomina questa variabile.',
    'Trova e correggi un errore difficile da riprodurre in una base di codice esistente.',
  ],
  Dutch: [
    'Hallo, hoe werkt een variabele in Java?',
    'Hernoem deze variabele.',
    'Vind en repareer een moeilijk reproduceerbare fout in een bestaande codebase.',
  ],
  Polish: [
    'Cześć, jak działa zmienna w Javie?',
    'Zmień nazwę tej zmiennej.',
    'Znajdź i napraw trudny do odtworzenia błąd w istniejącym kodzie.',
  ],
  Korean: [
    '안녕하세요, Java 변수는 어떻게 작동하나요?',
    '이 변수의 이름을 바꿔 주세요.',
    '기존 코드베이스에서 재현하기 어려운 버그를 찾아서 고쳐 주세요.',
  ],
}

for (const [language, [question, rename, hardBug]] of Object.entries(SPOT_CHECKS)) {
  describe(`spot checks in ${language}`, () => {
    test(`question is LOW: ${question}`, () => expect(levelFor(question)).toBe('low'))
    test(`rename is LOW: ${rename}`, () => expect(levelFor(rename)).toBe('low'))
    test(`hard bug is HIGH or above: ${hardBug}`, () => expect(['high', 'xhigh', 'max']).toContain(levelFor(hardBug)))
  })
}
