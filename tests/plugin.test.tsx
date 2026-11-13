// End-to-end through the engine's own hook chain: what effort the model
// requests actually carry, /reasoning, escalation, settings and the band.

import { expect, mock, test, type Engine, type Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

type Sent = { index: number; effort: string | number | undefined }

/** The engine beneath the plugin: records what each model request carries. */
function engine(
  on: On,
  sent: Sent[],
  logs: string[],
  configSets: { key: string; value: unknown }[] = [],
) {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__reasoning-controller__${e.name}` } }))
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('config.set', (_, e) => {
    configSets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    sent.push({ index: e.index, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  mock.store(on)
}

async function step($: Engine, turnId: string, index: number, model = 'claude-opus-5-5', effort: string | null = 'medium') {
  const stream = $.turn.step({ turnId, index, model, ...(effort ? { effort: effort as 'medium' } : {}), messageCount: 2 + index })
  for await (const _ of stream) {
    // drain
  }
  return stream.result
}

function reasoning($: Engine, args: string) {
  return $.command.run({
    command: 'reasoning',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
}

async function startSession($: Engine) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

test('AUTO: every request of a hard debugging task is sent at HIGH; a question at LOW', async ($, on) => {
  const sent: Sent[] = []
  const logs: string[] = []
  engine(on, sent, logs)
  await startSession($)

  await $.turn.start({ text: 'Finde und behebe einen schwer reproduzierbaren Fehler in einer bestehenden Codebasis.', turnId: 't1' })
  await step($, 't1', 0)
  await step($, 't1', 1)
  await step($, 't1', 2)
  expect(sent.map(s => s.effort)).toEqual(['high', 'high', 'high'])
  expect(logs[0]).toContain('Erkannte Aufgabe: Komplexes Debugging')
  expect(logs[0]).toContain('Ausgewählte Reasoning-Stufe: HIGH')
  // The notice names traits, never the prompt itself.
  expect(logs[0]).not.toContain('Codebasis')

  sent.length = 0
  await $.turn.start({ text: 'Hallo, wie funktioniert eine Java-Variable?', turnId: 't2' })
  await step($, 't2', 0)
  expect(sent.map(s => s.effort)).toEqual(['low'])
})

test('subagent requests and models without effort are left untouched', async ($, on) => {
  const sent: Sent[] = []
  engine(on, sent, [])
  await startSession($)
  await $.turn.start({ text: 'Führe eine tiefgehende Sicherheitsanalyse einer komplexen Implementierung durch.', turnId: 'a1', agentId: 'sub-1' })
  const stream = $.turn.step({ turnId: 'a1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1, agentId: 'sub-1' })
  for await (const _ of stream) {
    // drain
  }
  await $.turn.start({ text: 'Führe eine tiefgehende Sicherheitsanalyse einer komplexen Implementierung durch.', turnId: 't1' })
  await step($, 't1', 0, 'claude-haiku-4-5', null)
  expect(sent.map(s => s.effort)).toEqual(['medium', undefined])
})

test('/reasoning <level> overrides exactly one task, then AUTO resumes', async ($, on) => {
  const sent: Sent[] = []
  engine(on, sent, [])
  await startSession($)

  const r = await reasoning($, 'max')
  expect(r.text).toContain('MAX')
  await $.turn.start({ text: 'Benenne diese Variable um.', turnId: 't1' })
  await step($, 't1', 0)
  await $.turn.start({ text: 'Benenne diese Variable um.', turnId: 't2' })
  await step($, 't2', 0)
  expect(sent.map(s => s.effort)).toEqual(['max', 'low'])
})

test('/reasoning auto discards a pending override', async ($, on) => {
  const sent: Sent[] = []
  engine(on, sent, [])
  await startSession($)
  await reasoning($, 'xhigh')
  await reasoning($, 'auto')
  await $.turn.start({ text: 'Benenne diese Variable um.', turnId: 't1' })
  await step($, 't1', 0)
  expect(sent.map(s => s.effort)).toEqual(['low'])
})

test('a follow-up keeps the level of the task it continues', async ($, on) => {
  const sent: Sent[] = []
  engine(on, sent, [])
  await startSession($)
  await $.turn.start({ text: 'Analysiere die Architektur meines gesamten Projekts und plane ein umfangreiches Refactoring.', turnId: 't1' })
  await step($, 't1', 0)
  await $.turn.start({ text: 'ja, mach weiter', turnId: 't2' })
  await step($, 't2', 0)
  expect(sent.map(s => s.effort)).toEqual(['xhigh', 'xhigh'])
})

test('escalation on: three failed tool calls raise the rest of the task', async ($, on) => {
  const sent: Sent[] = []
  const logs: string[] = []
  engine(on, sent, logs)
  on('tool.call', () => ({ result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true }) as never)
  await startSession($)
  await $.turn.start({ text: 'Finde und behebe einen schwer reproduzierbaren Fehler in einer bestehenden Codebasis.', turnId: 't1' })
  await step($, 't1', 0)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await step($, 't1', 1)
  expect(sent.map(s => s.effort)).toEqual(['high', 'xhigh'])
  expect(logs.some(l => l.includes('Eskalation HIGH → XHIGH'))).toBe(true)
})

test('escalation on: Claude can ask for more reasoning through the tool', async ($, on) => {
  const sent: Sent[] = []
  engine(on, sent, [])
  await startSession($)
  await $.turn.start({ text: 'Implementiere eine überschaubare neue Funktion in meinem Projekt.', turnId: 't1' })
  await step($, 't1', 0)
  const r = await $.tool.call({ tool: 'mcp__reasoning-controller__request_more_reasoning', reason: 'Unerwartete Wechselwirkungen' } as never)
  expect(String((r as { result?: unknown }).result)).toContain('raised to high')
  await step($, 't1', 1)
  expect(sent.map(s => s.effort)).toEqual(['medium', 'high'])
})

test('escalation off: failures change nothing', { options: { autoEscalation: false } }, async ($, on) => {
  const sent: Sent[] = []
  engine(on, sent, [])
  on('tool.call', () => ({ result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true }) as never)
  await startSession($)
  await $.turn.start({ text: 'Finde und behebe einen schwer reproduzierbaren Fehler in einer bestehenden Codebasis.', turnId: 't1' })
  await step($, 't1', 0)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await step($, 't1', 1)
  expect(sent.map(s => s.effort)).toEqual(['high', 'high'])
})

test('stored settings are what the controller uses (max XHIGH, SPEED FIRST)', { options: { maxLevel: 'xhigh' } }, async ($, on) => {
  const sent: Sent[] = []
  engine(on, sent, [])
  await startSession($)
  await $.turn.start({ text: 'Führe eine tiefgehende Sicherheitsanalyse einer komplexen Implementierung durch.', turnId: 't1' })
  await step($, 't1', 0)
  expect(sent.map(s => s.effort)).toEqual(['xhigh'])
})

test('MANUAL with "session" sends the /effort level unchanged', { options: { mode: 'manual' } }, async ($, on) => {
  const sent: Sent[] = []
  const logs: string[] = []
  engine(on, sent, logs)
  await startSession($)
  await $.turn.start({ text: 'Führe eine tiefgehende Sicherheitsanalyse einer komplexen Implementierung durch.', turnId: 't1' })
  await step($, 't1', 0, 'claude-opus-5-5', 'high')
  expect(sent.map(s => s.effort)).toEqual(['high'])
})

test('transparency off: no notice, the level is still applied', { options: { showDecision: false } }, async ($, on) => {
  const sent: Sent[] = []
  const logs: string[] = []
  engine(on, sent, logs)
  await startSession($)
  await $.turn.start({ text: 'Benenne diese Variable um.', turnId: 't1' })
  await step($, 't1', 0)
  expect(sent.map(s => s.effort)).toEqual(['low'])
  expect(logs).toEqual([])
})

test('/reasoning mode and max-level persist through /config rows', async ($, on) => {
  const configSets: { key: string; value: unknown }[] = []
  engine(on, [], [], configSets)
  await startSession($)
  await reasoning($, 'mode quality')
  await reasoning($, 'max-level high')
  await reasoning($, 'escalation off')
  expect(configSets).toEqual([
    { key: 'reasoning-controller.mode', value: 'quality' },
    { key: 'reasoning-controller.maxLevel', value: 'high' },
    { key: 'reasoning-controller.autoEscalation', value: false },
  ])
})

test('statistics are kept across sessions as counts only', async ($, on) => {
  engine(on, [], [])
  await startSession($)
  await $.turn.start({ text: 'Benenne diese Variable um.', turnId: 't1' })
  await step($, 't1', 0)
  const status = await reasoning($, 'status')
  expect(status.text).toContain('Statistik (1 Aufträge)')
  expect(status.text).not.toContain('Variable')
})

const BAND = {
  plugin: 'reasoning-controller',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, bodyColumns: 100 },
} as const

test('the band shows mode, level and maximum, no task details, on every surface', async ($, on) => {
  engine(on, [], [])
  await startSession($)
  await $.turn.start({ text: 'Finde und behebe einen schwer reproduzierbaren Fehler in einer bestehenden Codebasis.', turnId: 't1' })
  await step($, 't1', 0)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    expect((await ui.find({ type: 'Text', text: /^HIGH$/ }))?.text).toBe('HIGH')
    const rest = (await ui.find({ type: 'Text', text: /Max Limit · MAX/ }))?.text
    expect(rest).toBe(' | Max Limit · MAX')
    await ui.unmount()
  }
})

const PANE = {
  plugin: 'reasoning-controller',
  component: 'Pane',
  requestId: 'reasoning-settings',
  props: {
    title: 'Reasoning-Einstellungen',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the settings pane writes a choice to the stored settings', async ($, on) => {
  const configSets: { key: string; value: unknown }[] = []
  engine(on, [], [], configSets)
  await startSession($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    await ui.press({ key: 'mode:quality' })
    await ui.press({ key: 'autoEscalation:toggle' })
    await ui.unmount()
  }
  expect(configSets).toEqual([
    { key: 'reasoning-controller.mode', value: 'quality' },
    { key: 'reasoning-controller.autoEscalation', value: false },
    { key: 'reasoning-controller.mode', value: 'quality' },
    { key: 'reasoning-controller.autoEscalation', value: false },
  ])
})

// ---- effort-cycle (Ctrl+↑/↓) interplay ----

/** Stands for effort-cycle's stored key pick. */
function keysPick(on: On, pick: { model: string; level: string } | null) {
  on('state.get', (_, e, next) =>
    e.plugin === 'effort-cycle' && e.key === 'override' ? { value: { value: pick, version: 1 } } : next(e),
  )
}

test('a level picked with effort-cycle keys wins: requests pass unchanged, no escalation', async ($, on) => {
  const sent: Sent[] = []
  const logs: string[] = []
  engine(on, sent, logs)
  keysPick(on, { model: 'claude-opus-5-5', level: 'low' })
  on('tool.call', () => ({ result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true }) as never)
  await startSession($)
  await reasoning($, 'max')
  await $.turn.start({ text: 'Finde und behebe einen schwer reproduzierbaren Fehler in einer bestehenden Codebasis.', turnId: 't1' })
  // Here the test stands where effort-cycle would apply its pick, so the
  // request reaches it as the engine had it: untouched by this mod.
  await step($, 't1', 0)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await step($, 't1', 1)
  expect(sent.map(s => s.effort)).toEqual(['medium', 'medium'])
  expect(logs[0]).toContain('Tastatur-Wahl (effort-cycle)')
  expect(logs[0]).toContain('Ausgewählte Reasoning-Stufe: LOW')
  expect(logs[0]).toContain('/reasoning MAX übergangen')
  expect(logs.some(l => l.includes('Eskalation'))).toBe(false)
})

test('a pick for another model is ignored', async ($, on) => {
  const sent: Sent[] = []
  engine(on, sent, [])
  keysPick(on, { model: 'claude-sonnet-5-5', level: 'max' })
  await startSession($)
  await $.turn.start({ text: 'Benenne diese Variable um.', turnId: 't1' })
  await step($, 't1', 0)
  expect(sent.map(s => s.effort)).toEqual(['low'])
})

// A stand-in for effort-cycle loaded beneath this mod (append tier): like the
// real one it records the level each main-loop request reaches it with as the
// engine's `base`, and reports what it saw and what was stored.
const EFFORT_CYCLE_BENEATH = {
  name: 'effort-cycle',
  tier: 'append',
  register(on) {
    on('turn.step', async function* ($, e, next) {
      const BASE = { plugin: 'effort-cycle', key: 'base' } as const
      if (typeof e.effort === 'string') {
        await $.state.set(BASE, { model: e.model, level: e.effort })
        const stored = (await $.state.get(BASE)).value
        $.ui.log(`stand-in saw ${e.effort}, stored ${stored?.level}`)
      }
      return yield* next(e)
    })
  },
} satisfies Plugin

test(
  "effort-cycle's record of the engine level stays the engine's while this mod rewrites",
  { plugins: [EFFORT_CYCLE_BENEATH] },
  async ($, on) => {
    const sent: Sent[] = []
    const logs: string[] = []
    engine(on, sent, logs)
    await startSession($)
    await $.turn.start({ text: 'Finde und behebe einen schwer reproduzierbaren Fehler in einer bestehenden Codebasis.', turnId: 't1' })
    await step($, 't1', 0)
    expect(sent.at(-1)?.effort).toBe('high')
    expect(logs).toContain('stand-in saw high, stored medium')
  },
)
