# Changelog

## 0.2.2 – 2026-11-13

- `config.set` calls name both members explicitly (`{ key: 'reasoning-controller.<field>', value: value }`).
- README: notes for the plugin directory review (stored counters vs. submitted prompts, scanner matches, own tool, own settings only).

## 0.2.1 – 2026-11-13

- Plugin directory review fixes: settings are written with fixed keys from the hooks themselves, the settings pane is answered by a `ui.press` hook, the escalation tool has its own `tool.call` hook, and no environment variable is read anymore.
- README: what the mod submits, which settings it writes, its tool and every hook.

## 0.2.0 – 2026-11-13

- First public release.
- Per-request effort selection via `turn.step` with local seven-dimension task analysis.
- Modes AUTO, BALANCED, QUALITY FIRST, SPEED FIRST and MANUAL; min/max limits; cost/time priority.
- `/reasoning` command, settings pane and `/config` rows.
- Automatic escalation (repeated tool failures, or the `request_more_reasoning` tool).
- Model-aware level mapping (Fable/Mythos 5.x, Opus 4.5–5.5, Sonnet 4.6–5.5, Haiku 5.5).
- Interplay with effort-cycle: a Ctrl+↑/↓ pick always wins and is never dropped.
- Compact status line: `Reasoning · AUTO | Currently · HIGH | Max Limit · MAX`.
