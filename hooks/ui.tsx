// Drawing: the one-line band above the prompt and the settings pane.
// Both read $.state and the settings; neither writes while drawing.

import { atom, read } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { bandParts } from './lib/format'
import { label } from './lib/levels'
import { MANUAL_CHOICES, MAX_CHOICES, MIN_CHOICES, MODE_LABEL, MODES, PRIORITIES, PRIORITY_LABEL } from './lib/settings'
import type { Field, Settings } from './lib/settings'
import { PANE_ID } from './state'

const current = atom({ plugin: 'reasoning-controller', key: 'current' } as const, null, { shape: 'decision-1' })
const pending = atom({ plugin: 'reasoning-controller', key: 'pending' } as const, null)

export async function setOption($: EngineInterface, field: Field, value: string | boolean): Promise<string | undefined> {
  const r = await $.config.set({ key: `${$.plugin.name}.${field}`, value })
  return r.deny
}

type Row = { field: Field; title: string; options: readonly string[]; labelOf: (o: string) => string }

const ROWS: readonly Row[] = [
  { field: 'mode', title: 'Arbeitsmodus', options: MODES, labelOf: o => MODE_LABEL[o as keyof typeof MODE_LABEL] ?? o },
  { field: 'maxLevel', title: 'Maximale Stufe', options: MAX_CHOICES, labelOf: o => o.toUpperCase() },
  { field: 'minLevel', title: 'Minimale Stufe', options: MIN_CHOICES, labelOf: o => o.toUpperCase() },
  {
    field: 'priority',
    title: 'Kosten/Zeit',
    options: PRIORITIES,
    labelOf: o => PRIORITY_LABEL[o as keyof typeof PRIORITY_LABEL] ?? o,
  },
  {
    field: 'manualLevel',
    title: 'Stufe bei MANUAL',
    options: MANUAL_CHOICES,
    labelOf: o => (o === 'session' ? '/effort' : o.toUpperCase()),
  },
]

const TOGGLES: readonly { field: 'autoEscalation' | 'showDecision' | 'aiClassifier'; title: string }[] = [
  { field: 'autoEscalation', title: 'Automatische Eskalation' },
  { field: 'showDecision', title: 'Entscheidung anzeigen' },
  { field: 'aiClassifier', title: 'KI-Klassifizierung (kleines Modell)' },
]

function valueOf(s: Settings, field: Field): string | boolean {
  if (field === 'manualLevel') return s.manualLevel ?? 'session'
  return s[field]
}

export function registerUi(on: On, settings: Settings): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = await read($, current)
    const p = await read($, pending)
    const { Box, Text } = $.ui.resolve(e)
    const parts = bandParts(v, settings, p)
    // Mode, level and limit only: the task and its reasons are in the notice
    // before each task and in /reasoning.
    const next1 = p !== null ? ` | Next · ${p.toUpperCase()}` : ''
    return (
      <Box>
        <Text dimColor>Reasoning · {parts.mode} | Currently · </Text>
        <Text bold>{parts.level}</Text>
        <Text dimColor>
          {next1} | {parts.limit}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, current)
    return (
      <Box flexDirection="column">
        <Text dimColor>
          Gilt für neue Aufträge. Gespeichert in den Einstellungen (auch unter /config).
        </Text>
        {ROWS.map(row => (
          <Box flexDirection="column">
            <Text bold>{row.title}</Text>
            <Box flexDirection="row" flexWrap="wrap">
              {row.options.map(o => (
                <Button
                  key={`${row.field}:${o}`}
                  label={row.labelOf(o)}
                  variant={valueOf(settings, row.field) === o ? 'primary' : 'secondary'}
                  onPress={() => void setOption($, row.field, o)}
                />
              ))}
            </Box>
          </Box>
        ))}
        {TOGGLES.map(t => (
          <Box flexDirection="row">
            <Button
              key={`${t.field}:toggle`}
              label={`${settings[t.field] ? '[x]' : '[ ]'} ${t.title}`}
              plain
              onPress={() => void setOption($, t.field, !settings[t.field])}
            />
          </Box>
        ))}
        <Text dimColor>
          {v === null || v.source === 'unsupported'
            ? 'Noch keine Entscheidung in dieser Sitzung.'
            : `Zuletzt: ${v.categoryLabel} → ${v.level ? label(v.level) : 'unverändert'}`}
        </Text>
        <Button key="close" label="Schließen" role="dismiss" onPress={() => void $.ui.close({ id: PANE_ID })} />
      </Box>
    )
  })
}
