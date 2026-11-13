// Local task analysis: no model call, no I/O, deterministic.
//
// A prompt is read along seven dimensions (each 0..3): complexity, scope,
// error-proneness (risk), correctness demand, autonomy, ambiguity and
// verification effort. A task type (debugging, refactoring, a question, ...)
// gives each dimension a base value; modifiers found in the text raise or
// lower it; the structure of the prompt (file references, numbered steps,
// stack traces, length) adds to scope and autonomy. Single words never decide
// on their own: "komplex" raises complexity by one step at most, and scope
// only counts in proportion to how hard the work itself is, so a long but
// simple list stays cheap while a short but hard proof does not.

import { atRank, rank, type Level } from './levels'

export type Dimension = 'complexity' | 'scope' | 'risk' | 'correctness' | 'autonomy' | 'ambiguity' | 'verification'

export type Dims = Record<Dimension, number>

export type Category =
  | 'greeting'
  | 'question'
  | 'trivial_edit'
  | 'content'
  | 'implement'
  | 'modify'
  | 'tests'
  | 'devops'
  | 'debug'
  | 'perf'
  | 'analysis'
  | 'refactor_arch'
  | 'security'
  | 'math'
  | 'unknown'

export type Analysis = {
  category: Category
  /** German label for the UI, e.g. "Komplexes Debugging". */
  categoryLabel: string
  dims: Dims
  /** Scope weighted by how demanding the work is (0..3). */
  effectiveScope: number
  /** Weighted demand, roughly 0..12. */
  score: number
  /** How sure the analysis is about its reading of the prompt, 0..1. */
  confidence: number
  /** A short follow-up ("ja, weiter") that continues the previous task. */
  isContinuation: boolean
  /** Short, user-facing traits behind the result (no prompt content). */
  traits: string[]
}

const ZERO: Dims = { complexity: 0, scope: 0, risk: 0, correctness: 0, autonomy: 0, ambiguity: 0, verification: 0 }

type CategoryDef = { id: Category; test: RegExp; base: Dims; label: string; trivial?: boolean }

const d = (c: number, s: number, r: number, k: number, a: number, u: number, v: number): Dims => ({
  complexity: c,
  scope: s,
  risk: r,
  correctness: k,
  autonomy: a,
  ambiguity: u,
  verification: v,
})

// Patterns run on folded text: lower case, umlauts as ae/oe/ue, ß as ss.
const CATEGORIES: readonly CategoryDef[] = [
  {
    id: 'greeting',
    test: /^(hallo|hi|hey|moin|servus|guten (morgen|tag|abend)|hello|danke( dir| schoen)?|thanks|thank you)[\s!,.]*$/,
    base: ZERO,
    label: 'Begrüßung',
    trivial: true,
  },
  {
    id: 'question',
    test: /^(\w+[,!]?\s+)?(wie|was|warum|wieso|weshalb|wozu|wann|wo|welche[rsmn]?|gibt es|kann man|erklaer\w*|what|how|why|when|where|which|is there|explain|does|do|is|are|can)\b|\?\s*$/,
    base: ZERO,
    label: 'Einfache Frage',
    trivial: true,
  },
  {
    id: 'trivial_edit',
    test: /\b(umbenenn\w*|benenne\b.*\bum\b|rename\w*|tippfehler\w*|typos?|rechtschreib\w*|formatier\w*|einrueck\w*|indent\w*|kommentare? (hinzufueg|ergaenz)\w*|add (a )?comments?|sortier\w* (die )?imports|sort imports|(entferne|loesche) (den |die |das )?(unbenutzt|ungenutzt)\w*|remove unused|(loesche|entferne) (diese|die) zeile|delete (this|the) line|aendere (den|die|das) (text|wert|namen|farbe|label)|change the (text|value|name|color|label))\b/,
    base: ZERO,
    label: 'Kleine, eindeutige Änderung',
    trivial: true,
  },
  {
    id: 'content',
    test: /\b(liste\w*|auflist\w*|list (of|all)|brainstorm\w*|ideen|ideas|vorschlaege|suggestions|entwurf|entwirf|draft|zusammenfass\w*|summar\w*|uebersetz\w*|translate|formulier\w*|(schreib\w*|verfass\w*) (einen|eine|ein) (kurzen? |kleinen? )?(text|e-?mail|mail|brief|beitrag|post|artikel|gedicht|slogan)|write (a|an) (short )?(email|text|post|article|poem|slogan))\b/,
    base: ZERO,
    label: 'Inhalt, Liste oder Entwurf',
    trivial: true,
  },
  {
    id: 'implement',
    test: /\b(implementier(e|en|t)?|implement|fuege? .{0,40}\bhinzu|hinzufueg\w*|add (a|an|the|support|new)\b|(erstell|bau|programmier|entwickl)\w* (eine?[nmrs]?|die|den|das|neue?[nmrs]?) (\w+ ){0,2}(funktion|methode|klasse|komponente|endpoint|endpunkt|api|modul|feature|seite|formular|skript|script|anwendung|app|plugin|mod|dienst|service)|build (a|an|the)|(schreib\w*) (eine?[nmrs]?) (\w+ ){0,2}(funktion|methode|klasse|skript|script)|write (a|an) (function|class|script|method|component)|create (a|an) (function|class|component|endpoint|app)|neue[nmrs]? (funktion|funktionalitaet|feature)|new feature)\b/,
    base: d(1, 1, 0, 0, 1, 0, 1),
    label: 'Feature-Implementierung',
  },
  {
    id: 'modify',
    test: /\b(aender\w*|passe? .{0,40}\ban\b|anpass\w*|update\w*|aktualisier\w*|erweiter\w*|change|modify|extend|adjust|tweak)\b/,
    base: d(1, 1, 0, 0, 1, 0, 0),
    label: 'Codeänderung',
  },
  {
    id: 'tests',
    test: /\b(tests? (schreiben|schreib|hinzufueg|ergaenz)\w*|schreib\w* (\w+ ){0,2}tests?|write (\w+ ){0,2}tests?|unit ?tests?|testabdeckung|test coverage)\b/,
    base: d(1, 1, 0, 1, 1, 0, 1),
    label: 'Tests schreiben',
  },
  {
    id: 'devops',
    test: /\b(deploy\w*|docker\w*|kubernetes|k8s|ci\/cd|pipeline\w*|github actions|terraform|helm)\b/,
    base: d(1, 1, 1, 0, 1, 0, 1),
    label: 'Build/Deployment',
  },
  {
    id: 'debug',
    test: /\b(fehler(?!behandlung|meldungstext)\w*|bugs?|bugfix\w*|fix(e|es|ed|ing)?|behebe?n?|beheb\w*|debug\w*|crash\w*|absturz|stuerzt|exception\w*|stack ?trace|traceback|funktioniert (nicht|nicht mehr)|geht nicht|kaputt|broken|doesn'?t work|not working|failing|fails|schlaegt fehl|fehlschlag\w*|(this|the|that|ein|einen|diesen|der) error|haengt|freez\w*)\b/,
    base: d(2, 0, 1, 1, 1, 2, 2),
    label: 'Debugging',
  },
  {
    id: 'perf',
    test: /\b(performance|optimier\w*|optimi[sz]\w*|langsam|slow|speicherleck\w*|memory leaks?|latenz|latency|durchsatz|throughput|bottlenecks?|engpass)\b/,
    base: d(2, 1, 1, 0, 1, 2, 2),
    label: 'Performance-Analyse',
  },
  {
    id: 'analysis',
    test: /\b(analysier\w*|analyse|analysis|analy[sz]e|untersuch\w*|investigat\w*|review\w*|pruef\w*|audit\w*|bewerte\w*|evaluier\w*|evaluate|begutacht\w*|assess\w*)\b/,
    base: d(2, 1, 0, 0, 1, 1, 1),
    label: 'Technische Analyse',
  },
  {
    id: 'refactor_arch',
    test: /\b(refactor\w*|refaktor\w*|umstrukturier\w*|restrukturier\w*|architektur\w*|architecture|architectur\w*|redesign\w*|neu (strukturier|aufbau|gestalt)\w*|modularisier\w*|migrier\w*|migration|portier\w*|port (to|from)|umstell\w*|rewrite|neu schreiben)\b/,
    base: d(2, 2, 2, 1, 2, 1, 2),
    label: 'Architektur/Refactoring',
  },
  {
    id: 'security',
    test: /\b(sicherheit\w*|security|vulnerab\w*|schwachstell\w*|sicherheitsluecke\w*|exploit\w*|injection|xss|csrf|ssrf|authentifizier\w*|authentication|autorisier\w*|authorization|kryptograph\w*|cryptograph\w*|verschluessel\w*|encrypt\w*|pentest\w*|threat model\w*|bedrohungs\w*|owasp|cve)\b/,
    base: d(1, 0, 3, 3, 1, 1, 2),
    label: 'Sicherheitsanalyse',
  },
  {
    id: 'math',
    test: /\b(beweis\w*|prove|proof|theorem|lemma|mathemat\w*|gleichung\w*|equations?|integral\w*|ableitung\w*|derivative|kombinatori\w*|combinatori\w*|wahrscheinlichkeit\w*|probabilit\w*|zahlentheori\w*|number theory|algebra\w*|geometri\w*|induktion\w*|induction|invariante?n?|komplexitaetsklasse\w*|np-(hart|hard|vollstaendig|complete)|optimalitaet|optimality)\b/,
    base: d(2, 0, 0, 2, 0, 1, 1),
    label: 'Mathematisches Problem',
  },
]

const DIFFICULTY =
  /schwer reproduzierbar|nicht reproduzierbar|hard to reproduce|intermittier\w*|sporadisch\w*|flaky|race conditions?|wettlaufbedingung\w*|deadlocks?|heisenbug|nebenlaeufig\w*|concurren\w*|nicht offensichtlich\w*|non-?obvious|subtil\w*|subtle|schwierig\w*|\bschwer\b|\bhard\b|difficult|tricky|knifflig\w*|anspruchsvoll\w*|challenging|tiefgehend\w*|tiefgreifend\w*|in-?depth|\bdeep\b|gruendlich\w*|thorough\w*|rigoros\w*|rigorous|\bformal\w*|komplex\w*|complex\w*|kompliziert\w*|complicated|ursache (ist )?(unbekannt|unklar)|unknown cause|raetselhaft\w*|mysterious/g

const SIMPLE =
  /\b(einfach\w*|simple|simpel\w*|trivial\w*|kurz\w*|quick\w*|schnell\w*|nur|just|kleine?[rnms]?|small|minor|leicht\w*|easy|basic|grundlegend\w*)\b/g

const SMALL_SCOPE =
  /\b(nur|just|kleine?[rnms]?|small|einzelne?[rnms]?|single|ueberschaubar\w*|manageable|diese[rsn]? (eine )?(zeile|variable|funktion|datei|methode|stelle)|this (line|variable|function|file|method))\b/g

const SCOPE =
  /\b(gesamte[nmrs]?|ganze[nmrs]?) (projekt|codebas|code|anwendung|app|repo|system|loesung)\w*|\b(whole|entire) (project|codebase|code ?base|app|application|repo|system)|\balle[nmrs]? (dateien|module|komponenten|services|klassen|endpunkte|tests)|\ball (files|modules|components|services|classes|endpoints)|projektweit|codebase-?weit|across the (codebase|project)|umfangreich\w*|extensive|large-?scale|grossflaechig\w*|massiv\w*|\bmehrere[nmrs]? (dateien|module|komponenten|services|repos|klassen|schichten)|\bmultiple (files|modules|components|services|repos|layers)|\bviele[nmrs]? (dateien|module|komponenten)|\bmany (files|modules)|end-?to-?end|full-?stack|monorepo|bestehende[nmrs]? (codebas|projekt|anwendung|system)\w*|existing (codebase|project|application|system)/g

const RISK =
  /produktion\w*|production|\bprod\b|live-?system\w*|datenbank-?migration\w*|database migration|datenverlust|data loss|breaking changes?|abwaertskompatib\w*|backwards? compat\w*|seiteneffekt\w*|nebeneffekt\w*|side[- ]effects?|transaktion\w*|transactions?|zahlung\w*|payments?|billing|abrechnung\w*|legacy|bestehende[nmrs]? (codebas|projekt|anwendung|system)\w*|existing (codebase|project|application|system)|multithread\w*|nebenlaeufig\w*|concurren\w*|race conditions?|deadlocks?/g

const CORRECTNESS =
  /kritisch\w*|critical|korrektheit|correctness|exakt\w*|\bprecise\w*|praezise?\w*|fehlerfrei\w*|bulletproof|wasserdicht\w*|100 ?%|zuverlaessig\w*|reliab\w*|beweis\w*|\bproof\b|medizin\w*|medical|finanz\w*|financ\w*|rechtlich\w*|\blegal\b|compliance|haftung|sicherheitskritisch\w*|safety|must not fail|darf nicht (fehlschlagen|ausfallen)/g

const AUTONOMY =
  /selbststaendig\w*|eigenstaendig\w*|autonom\w*|ohne rueckfrage\w*|\bplane\b|\bplanen\b|\bplanung\b|\bplan (and|und)\b|planning|von grund auf|from scratch|komplett\w*|vollstaendig\w*|\bcompletely\b|end-?to-?end|mehrstufig\w*|multi-?step|schritt fuer schritt|step by step|\bund (dann|anschliessend|danach)\b|\band then\b|afterwards/g

const AMBIGUITY =
  /\bmehrere[nmrs]? (moegliche|loesungs|ansaetze|ursachen|optionen|wege|varianten)\w*|\bseveral (possible|approaches|options|causes|ways)|\bmultiple (approaches|options|causes|ways)|vergleich\w*|\bcompare\b|abwaeg\w*|trade-?offs?|vor- und nachteile|pros and cons|\bwelche[rsmn]? (ansatz|loesung|option|variante|bibliothek|library|framework|architektur)|\bwhich (approach|solution|option|library|framework)|unklar\w*|unclear|keine ahnung (warum|wieso)|not sure (why|how)|alternativ\w*|strategie\w*|strategy|abwaegung\w*/g

const VERIFICATION =
  /\btests?\b|\btesten\b|\bteste\b|test suite|verifizier\w*|\bverify\w*|verification|validier\w*|\bvalidate\b|stelle? sicher|sicherstell\w*|\bensure\b|make sure|regressions?|edge ?cases?|randfaell\w*|grenzfaell\w*|\bci\b|coverage|abdeckung|ueberpruef\w*|double-?check|gegenpruef\w*/g

const CONTINUATION_WORD =
  '(ja|jo|jep|yes|yep|y|ok(ay)?|k|weiter|mach weiter|weitermachen|fortfahren|continue|go( on| ahead)?|proceed|passt|genau|gut|super|perfekt|perfect|sounds good|do it|mach( das| es)?( so)?|bitte|please( do)?|einverstanden|klingt gut|nochmal|again|try again|versuch(e)? es nochmal|und jetzt|next|naechste[rs]?|los)'
// One to three such words and nothing else: "ja, mach weiter", "ok bitte".
const CONTINUATION = new RegExp(`^${CONTINUATION_WORD}([\\s!.,]+${CONTINUATION_WORD}){0,2}[\\s!.,]*$`)

const FILE_REF =
  /[\w\-/\\]+\.(tsx?|jsx?|mjs|cjs|java|kt|py|rb|go|rs|cs|cpp|c|h|hpp|php|swift|scala|sql|json|ya?ml|toml|xml|html|css|scss|md|gradle|sh|ps1)\b/g

const STACK_TRACE = /(exception|traceback|error:|\bat [\w.$]+\(|panicked at|segmentation fault)/

export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
}

function countDistinct(re: RegExp, text: string): number {
  const found = new Set<string>()
  for (const m of text.matchAll(re)) found.add(m[0])
  return found.size
}

const cap = (n: number) => Math.max(0, Math.min(3, n))

/** Score thresholds between low|medium, medium|high, high|xhigh, xhigh|max. */
export const THRESHOLDS = [1.5, 3.5, 7.5, 9.5] as const

const WEIGHTS: Dims = {
  complexity: 1.0,
  scope: 0.6,
  risk: 0.5,
  correctness: 0.6,
  autonomy: 0.6,
  ambiguity: 0.4,
  verification: 0.3,
}

export function analyze(text: string): Analysis {
  const raw = text.trim()
  const codeBlocks = [...raw.matchAll(/```[\s\S]*?(```|$)/g)].map(m => m[0])
  const prose = fold(raw.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  const words = prose.length === 0 ? 0 : prose.split(' ').length

  if (prose.length === 0 && codeBlocks.length === 0) {
    return continuation()
  }
  if (prose.length <= 40 && codeBlocks.length === 0 && CONTINUATION.test(prose)) {
    return continuation()
  }

  // Task type: every matching type contributes its base, the strongest
  // substantive one names the task. Trivial types name it only when nothing
  // substantive matched.
  const matched = CATEGORIES.filter(c => c.test.test(prose))
  const hasStackTrace = codeBlocks.some(b => STACK_TRACE.test(fold(b)))
  if (hasStackTrace && !matched.some(c => c.id === 'debug')) {
    const debug = CATEGORIES.find(c => c.id === 'debug')
    if (debug) matched.push(debug)
  }
  const substantive = matched.filter(c => !c.trivial)
  const named =
    [...substantive].sort((a, b) => total(b.base) - total(a.base))[0] ??
    matched.find(c => c.id === 'trivial_edit') ??
    matched.find(c => c.id === 'content') ??
    matched.find(c => c.id === 'question') ??
    matched[0]
  const category: Category = named?.id ?? 'unknown'

  const dims: Dims = { ...ZERO }
  for (const c of substantive.length > 0 ? substantive : matched) {
    for (const k of Object.keys(dims) as Dimension[]) dims[k] = Math.max(dims[k], c.base[k])
  }

  // Modifiers from the wording.
  const difficulty = countDistinct(DIFFICULTY, prose)
  const simple = countDistinct(SIMPLE, prose)
  const smallScope = countDistinct(SMALL_SCOPE, prose)
  const scope = countDistinct(SCOPE, prose)
  const risk = countDistinct(RISK, prose)
  const correctness = countDistinct(CORRECTNESS, prose)
  const autonomy = countDistinct(AUTONOMY, prose)
  const ambiguity = countDistinct(AMBIGUITY, prose)
  const verification = countDistinct(VERIFICATION, prose)

  dims.complexity += Math.min(2, difficulty)
  // "einfach", "kurz", "nur" lower the difficulty only when nothing says the
  // opposite: "kurz, aber schwierig" stays hard.
  if (difficulty === 0 && simple > 0) dims.complexity -= 1
  dims.scope += scope - (smallScope > 0 ? 1 : 0)
  dims.risk += risk
  dims.correctness += correctness
  dims.autonomy += autonomy
  dims.ambiguity += ambiguity
  dims.verification += verification

  // Structure of the prompt.
  const files = new Set([...fold(raw).matchAll(FILE_REF)].map(m => m[0])).size
  const listItems = raw.split('\n').filter(line => /^\s*(\d+[.)]|[-*•])\s+\S/.test(line)).length
  if (files >= 3) dims.scope += 1
  if (files >= 6) dims.scope += 1
  if (listItems >= 3) dims.autonomy += 1
  if (listItems >= 6) {
    dims.autonomy += 1
    dims.scope += 1
  }
  if (prose.length > 1200) dims.scope += 1
  if (hasStackTrace) dims.verification += 1

  // A question about something asks for an answer, not for autonomous work.
  const isQuestion = matched.some(c => c.id === 'question')
  const asksForWork = substantive.some(c => c.id !== 'analysis')
  if (isQuestion && !asksForWork) dims.autonomy -= 1

  for (const k of Object.keys(dims) as Dimension[]) dims[k] = cap(dims[k])

  // Scope only matters as far as the work is demanding: twenty simple list
  // items are not twenty hard problems.
  const demanding = (dims.complexity + dims.autonomy + dims.risk) / 3
  const effectiveScope = dims.scope * Math.min(1, demanding)

  const score =
    WEIGHTS.complexity * dims.complexity +
    WEIGHTS.scope * effectiveScope +
    WEIGHTS.risk * dims.risk +
    WEIGHTS.correctness * dims.correctness +
    WEIGHTS.autonomy * dims.autonomy +
    WEIGHTS.ambiguity * dims.ambiguity +
    WEIGHTS.verification * dims.verification

  const modifiers = difficulty + scope + risk + correctness + autonomy + ambiguity + verification
  let confidence: number
  if (category === 'unknown') {
    confidence = 0.25 + 0.1 * Math.min(3, modifiers)
  } else if (named?.trivial) {
    confidence = prose.length <= 300 ? 0.85 : 0.5
  } else {
    confidence = 0.65 + 0.07 * Math.min(4, modifiers)
  }
  if (words <= 2 && category !== 'greeting' && category !== 'trivial_edit') confidence = Math.min(confidence, 0.4)
  confidence = Math.min(0.95, confidence)

  return {
    category,
    categoryLabel: labelFor(category, named?.label, dims),
    dims,
    effectiveScope,
    score: round(score),
    confidence: round(confidence),
    isContinuation: false,
    traits: traitsFor(dims, effectiveScope, words),
  }
}

function continuation(): Analysis {
  return {
    category: 'unknown',
    categoryLabel: 'Fortsetzung',
    dims: { ...ZERO },
    effectiveScope: 0,
    score: 0,
    confidence: 0.9,
    isContinuation: true,
    traits: ['Fortsetzung des vorherigen Auftrags'],
  }
}

function total(dims: Dims): number {
  return Object.values(dims).reduce((a, b) => a + b, 0)
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function labelFor(category: Category, base: string | undefined, dims: Dims): string {
  if (category === 'unknown') return 'Allgemeiner Auftrag'
  if (category === 'debug' && dims.complexity >= 3) return 'Komplexes Debugging'
  if (category === 'question' && dims.complexity >= 2) return 'Anspruchsvolle Frage'
  if (category === 'implement' && (dims.scope >= 3 || dims.autonomy >= 3)) return 'Umfangreiche Implementierung'
  if (category === 'security' && dims.complexity >= 3) return 'Tiefgehende Sicherheitsanalyse'
  if (category === 'math' && dims.complexity >= 3) return 'Schwieriges mathematisches Problem'
  return base ?? 'Allgemeiner Auftrag'
}

function traitsFor(dims: Dims, effectiveScope: number, words: number): string[] {
  const t: string[] = []
  if (dims.complexity >= 3) t.push(words <= 15 ? 'kurz formuliert, aber inhaltlich schwierig' : 'hohe inhaltliche Schwierigkeit')
  else if (dims.complexity === 2) t.push('anspruchsvolles Problem')
  if (effectiveScope >= 2) t.push('viele Dateien oder Komponenten betroffen')
  if (dims.risk >= 2) t.push('relevante Seiteneffekte möglich')
  if (dims.correctness >= 3) t.push('sehr hohe Korrektheitsanforderung')
  else if (dims.correctness === 2) t.push('hohe Korrektheitsanforderung')
  if (dims.autonomy >= 2) t.push('mehrstufige, eigenständige Bearbeitung')
  if (dims.ambiguity >= 2) t.push('mehrere mögliche Ursachen oder Lösungswege')
  if (dims.verification >= 2) t.push('umfangreiche Verifikation nötig')
  if (t.length === 0) {
    t.push(dims.scope >= 1 && effectiveScope < 1 ? 'umfangreich, aber inhaltlich einfach' : 'klar umrissene, überschaubare Aufgabe')
  }
  return t
}

/**
 * The level a score asks for, with the structural guards: XHIGH needs breadth
 * or autonomy, MAX needs critical correctness on top of real difficulty, and
 * a hard problem never drops below HIGH however short it is.
 */
export function levelForScore(score: number, a: Pick<Analysis, 'dims' | 'effectiveScope'>, allowMaxRule = true): Level {
  const { dims } = a
  let r = THRESHOLDS.findIndex(t => score < t)
  if (r === -1) r = THRESHOLDS.length
  let level = atRank(r)

  if (dims.complexity >= 3 && rank(level) < rank('high')) level = 'high'
  const maxJustified = dims.correctness >= 3 && (dims.complexity >= 3 || dims.risk >= 3)
  if (level === 'max' && !maxJustified) level = 'xhigh'
  const xhighJustified =
    dims.autonomy >= 2 ||
    a.effectiveScope >= 2 ||
    (dims.complexity >= 3 && (dims.ambiguity >= 2 || dims.correctness >= 3))
  if (level === 'xhigh' && !xhighJustified) level = 'high'
  if (allowMaxRule && dims.correctness >= 3 && dims.complexity >= 3 && (dims.risk >= 3 || dims.verification >= 3)) {
    level = 'max'
  }
  return level
}
