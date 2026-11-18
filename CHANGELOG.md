# Changelog

## 0.7.0 – 2026-11-18

- New status line: `Mode ◆ AUTO  ·  Reasoning ▰▰▰▱▱ HIGH  ·  Limit MAX`, with an icon per mode (◆ AUTO, ⚖ BALANCED, ★ QUALITY FIRST, ⚡ SPEED FIRST, ✋ MANUAL) and a five-step meter in effort-cycle's colours (LOW grey, MEDIUM green, HIGH yellow, XHIGH orange, MAX red).
- Terminal: the line moved to the left of the hint line under the prompt and stays clickable.
- Desktop app: the line sits at the left of the band above the input, as plain text with even spacing; other plugins' content in that band is kept.
- 169 tests.

## 0.6.0 – 2026-11-18

- Status line: same words, now with the current level coloured from cool to hot. A click on "Reasoning · AUTO" opens the settings; a click on the level picks the next task's level (auto → LOW → … → MAX → auto). It can be hidden (`/reasoning statusline off`).
- Cost overview in `/reasoning`: average output tokens per task and level, and an estimate of the tokens saved against always running at HIGH.
- Your own rules (`/config` → "Reasoning: rules"), e.g. `/quick=low; infra/>=high; readme<=medium`.
- Learning from your overrides: after three `/reasoning` overrides in the same direction for a task type, that type runs one level higher or lower. Task types and level steps only; `/reasoning reset-learning`; can be turned off.
- Project profiles (`/config` → "Reasoning: project profiles"): min/max per project folder, e.g. `playground: max=high`.
- README: fixed a broken row in the command table.
- 168 tests.

## 0.5.0 – 2026-11-18

- New task type "Routine operation": git commit/push/pull, running tests, building, installing dependencies, showing a file or log run at `low`, in all 12 languages, even when the session runs at `high`. A prompt that also asks for real work (fixing a bug, resolving merge conflicts) is still classified by that work.
- Short command-like prompts such as `git push` or `npm install` are no longer treated as unclear.
- AI classification is now a choice: `off`, `unclear` (only when the local analysis is unsure) or `always` (the small model picks the level for every new task). The setting is now called `aiClassification`; a previous `aiClassifier` value is not carried over.
- The small model's instructions now describe routine operations and say that the request may be in any language.
- 152 tests.

## 0.4.0 – 2026-11-17

- Prompt recognition in 12 languages: English, German, Spanish, French, Portuguese, Italian, Dutch, Polish, Russian, Chinese, Japanese and Korean (`hooks/lib/multilingual.ts`).
- Language-neutral text handling: accents are folded (é → e, ñ → n, ł → l), Spanish ¿¡ and full-width ？！ are understood, and Chinese, Japanese and Korean are measured by characters rather than spaces.
- Other languages keep the language-neutral signals and fall back to the session level; the optional AI classification covers every language.
- A recognised rename or typo fix is no longer also counted as a general code change.
- 126 tests, including the reference tasks in seven languages.

## 0.3.0 – 2026-11-17

- The whole interface is now in English: status line, notices, `/reasoning` output, settings pane and `/config` rows.
- Task analysis still understands German prompts; the reference tasks are tested in English and German.
- Better English classification: "small" now narrows scope instead of difficulty, and "list" is recognised as a writing task.
- The German README (`docs/README.de.md`) is removed.

## 0.2.3 – 2026-11-13

- The mod submits no prompts anymore: `/reasoning <level> <task>` only notes the level; you send the task yourself.
- Parser names renamed (`set` → `choice`/`entry`) so they no longer read like a shell command.
- The SVG logo source is no longer shipped (not an accepted file type); the PNG icon stays.

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
