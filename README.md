<p align="center"><img src=".claude-plugin/icon.png" alt="Adaptive Reasoning Controller logo" width="160"></p>

# Adaptive Reasoning Controller for Claude Code

A Claude Code mod that picks the right **effort level** (`low`, `medium`, `high`, `xhigh`, `max`) for every task and **actually sends it with each model request**. It does not add "think harder" hints to the prompt.

The goal is not maximum reasoning. The goal is the effort a task needs: quick answers stay fast and cheap, and hard debugging, large refactors or security reviews get the depth they deserve.


```
Mode ◆ AUTO  ·  Reasoning ▰▰▰▱▱ HIGH  ·  Limit MAX
```

The icon shows the working mode: ◆ AUTO, ⚡ SPEED, ★ QUALITY, ✋ MANUAL. The meter and the level use the same colours as effort-cycle's meter: LOW grey, MEDIUM green, HIGH yellow, XHIGH orange, MAX red. A next-task level shows as `·  Next MAX`, a minimum as `Limit MEDIUM–MAX`.

- **Terminal:** at the left of the hint line under the prompt, before Claude Code's own hint. **Click** "Mode ◆ AUTO" to open the settings, or **click the reasoning meter** to pick the next task's level (auto → LOW → MEDIUM → HIGH → XHIGH → MAX → auto).
- **Desktop app:** at the left of the band above the input (the desktop app keeps the footer under the input for its own controls). There the line is plain text so that spacing and colours stay right, with a small **⚙ button** before it that opens the settings; pick the next task's level with `/reasoning <level>`.

The line can be hidden in the settings.

## Install

Requires Claude Code **2.1.275 or later** (function-hooks mods). It was developed and tested with 2.1.321.

At the prompt of a terminal session:

```
/plugin install reasoning-controller --marketplace XxRexRaptorxX/claude-reasoning-controller
```

Answer `y` to *Add marketplace?*, then pick a scope (Enter = user).

From a shell:

```bash
claude plugin install reasoning-controller --marketplace XxRexRaptorxX/claude-reasoning-controller
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, choose **Plugins**, then **Add marketplace** with `XxRexRaptorxX/claude-reasoning-controller`, then **Add plugin**.

## How it works

Claude Code raises the `turn.step` event before every model request, with the `effort` that request would carry. The mod answers `next({ ...e, effort })`, which changes the request's real effort parameter. It never changes the prompt.

1. **Local task analysis (no extra model call):** each task is scored 0–3 on seven dimensions: complexity, scope, error-proneness, correctness demand, autonomy, ambiguity and verification effort. The task type gives base values; the wording and the structure of the prompt (file references, numbered steps, stack traces) adjust them. Single keywords never decide on their own. Scope only counts in proportion to how hard the work is, so a long but simple list stays `low` while a short but hard proof gets at least `high`. Routine operations (git commit/push, running tests, building, installing dependencies, showing a file or log) are recognised as such and run at `low`, unless the prompt also asks for real work such as fixing a bug. It understands prompts in **12 languages**: English, German, Spanish, French, Portuguese, Italian, Dutch, Polish, Russian, Chinese, Japanese and Korean. In any other language, the language-neutral signals still count (code blocks, stack traces, file references, numbered steps, length), an unclear prompt keeps the session level, and the optional AI classification works for every language.
2. **AI classification:** by default (`unclear`) Claude Code's small, fast model is asked for the level only when the local analysis is unsure; `/reasoning ai always` lets it decide for every new task, `/reasoning ai off` turns it off. It costs one short request and a little latency per task it is asked for; your limits, mode and the stability rules still apply, and if the request fails the local analysis decides.
3. **Selection strategy:** it starts from the session's own level (`/effort` or the model default). It lowers that level only for clearly simple tasks and uses `xhigh`/`max` only with structural justification. Close calls keep the previous level (hysteresis). Long conversations are not stepped down by a single level, to protect the prompt cache. Follow-ups such as "ok, continue" keep the current level.
4. **Model-aware:** it knows which levels each model family takes and picks the nearest supported level. For example, `xhigh` becomes `high` on Opus 4.6. Models without effort support are left untouched.
5. **Escalation (optional):** after three failed tool calls in one task, or when Claude calls the `request_more_reasoning` tool, the rest of the task runs one level higher, within your maximum.

## Usage

| Command | Effect |
|---|---|
| `/reasoning` | Status, last decision, statistics |
| `/reasoning high` | `high` for the **next task only**; takes precedence over AUTO and min/max |
| `/reasoning auto` | Discard a pending override |
| `/reasoning mode auto\|speed\|quality\|manual` | Working mode: AUTO as analysed; SPEED one level lower, at most HIGH; QUALITY one level higher, at least MEDIUM; MANUAL a fixed level |
| `/reasoning max-level medium\|high\|xhigh\|max` | Upper limit |
| `/reasoning min-level low\|medium\|high` | Lower limit |
| `/reasoning manual session\|low…max` | Level in MANUAL mode (`session` = leave `/effort` alone) |
| `/reasoning ai off\|unclear\|always` | AI classification by the small model: never, when unclear, for every task |
| `/reasoning escalation on\|off` · `display on\|off` · `statusline on\|off` · `learning on\|off` | Toggles |
| `/reasoning settings` | Settings pane |
| `/reasoning reset-stats` · `reset-learning` | Clear the statistics and token counts · forget what was learned |

All settings are stored in `settings.json` (under `pluginConfigs`) and appear as rows in `/config`.

| Setting | Default |
|---|---|
| Mode: AUTO, SPEED, QUALITY, MANUAL | AUTO |
| Max level | MAX (used only when clearly justified) |
| Min level | LOW |
| Automatic escalation | on |
| Show decision before each task | on |
| AI classification (small model): off, unclear, always | unclear |
| Show the status line | on |
| Rules (text, see below) | empty |
| Learn from my overrides | on |
| Project profiles (text, see below) | empty |

### Rules

Your own rules in `/config` → "Reasoning: rules", separated by `;`. The text is matched case-insensitively in the prompt:

```
/quick=low; infra/>=high; readme<=medium
```

`text=level` sets the level exactly, `text>=level` sets a minimum, `text<=level` a maximum. Rules apply before your min/max limits. `/reasoning` lists the rules in force and any it could not read.

### Project profiles

Limits per project folder in `/config` → "Reasoning: project profiles", separated by `;`. The text before `:` is matched against the session's folder path; the first match replaces min/max for that session:

```
playground: max=high; payments-api: min=medium max=xhigh
```

### Learning from your overrides

When you pick another level with `/reasoning <level>` (or a click on the status line), the controller notes how far your pick was from its own choice for that **task type**. After three such overrides in the same direction, that task type runs one level higher or lower (never more than one, always within your limits). Only task types and level steps are kept, never prompt text. `/reasoning reset-learning` forgets it; it can be turned off in the settings.

### Cost overview

`/reasoning` shows the average output tokens per task for each level (thinking included) and, once at least three tasks ran at HIGH, an estimate of the output tokens saved against running everything at HIGH.

## Works with effort-cycle

When [effort-cycle](https://github.com/Anerco/claude-code-effort-cycle) is installed, a level you pick with **Ctrl+↑/↓ always wins**. While that pick is active, requests pass through untouched. The mod also keeps effort-cycle's record of the engine level correct, so your pick is not dropped, whatever the load order of the two plugins.

## Limits

- If you have set up Claude Code to send effort **per message** (a model capability you configure yourself; this mod does not check or change it), a mid-task escalation applies from the next user message.
- On models that take effort per request (the default), changing the level between tasks invalidates the messages prompt cache. That is why the mod avoids needless switches.
- Subagents keep their own effort, as their definitions set it.
- Organization policy, the `maxEffortLevel` setting and model capabilities still apply on top.
- The function-hooks mod API is early access and may change between Claude Code releases.

## Privacy

- **No prompt text is stored.** Session state holds only task traits. The persistent store holds counts only: decisions per level, escalations, overrides, output tokens per level, and the level steps learned per task type.
- Extra model calls only through the AI classification: by default (`unclear`) the first 4,000 characters of a prompt the local analysis cannot classify are sent to Claude Code's own small, fast model; with `always` every new task's prompt; with `off` none.
- The only thing the model sees from this mod is the short description of the escalation tool, and only while escalation is enabled.
- The mod reads no credentials and no environment variables, and it makes no network requests of its own.

### Notes for the plugin directory review

- **The mod submits no prompts.** `$.store` holds only anonymous counters (`stats`: number of decisions per level and source, escalations, overrides), which `/reasoning status` reads to display them.
- **No credentials:** `hooks/lib/classifier.ts` contains the words `mail`/`email` only inside a regular expression that recognises tasks like "write an e-mail" (to classify them as simple writing tasks). The mod runs no shell commands, reads no environment variables, files or credentials, and has no code path that sends anything off the machine.
- **`tool.call` results of its own:** only for this mod's own tool `mcp__reasoning-controller__request_more_reasoning` (see *Tools*). It does not stand in for any other tool.
- **`config.set`:** only the mod's own eight `reasoning-controller.*` rows, with fixed keys (see *Configuration and environment*). It never touches permission modes or any other setting.

## What the mod changes

### Prompts

The mod **submits no prompts** of its own. It never modifies, extends or replaces any prompt you type, and it adds no reasoning instructions to the system prompt. `/reasoning <level>` only notes the level for your next task; you then send the task yourself.

### Configuration and environment

- **Configuration:** the mod writes only its **own** settings, which are the eleven `/config` rows listed under *Usage* (stored by Claude Code in `settings.json` under `pluginConfigs`, keys `reasoning-controller.<field>`). It writes them only when you change one through `/reasoning mode|max-level|min-level|manual|ai|escalation|display|statusline|learning …` or the `/reasoning settings` pane (rules and project profiles only in `/config`). It never writes any other setting.
- **Environment variables:** none are set or read.
- **Effort:** the effort level is not written to any setting. It is passed per request through `turn.step` (see *How it works*), so `/effort` and your settings files stay as they are.

### Tools

The mod adds one tool, `request_more_reasoning` (listed as `mcp__reasoning-controller__request_more_reasoning`, only while automatic escalation is on). Claude may call it when a task turns out harder than expected; it raises the effort for the rest of that task. The mod answers only this, its own tool. It does **not** stand in for any other tool: every other tool call passes through unchanged, and its result is returned as the tool produced it.

### Hooks

| Hook | What it does |
|---|---|
| `session.start` | Registers the `/reasoning` command and, if escalation is on, the `request_more_reasoning` tool. |
| `turn.start` (main conversation only) | Analyses the new task locally and takes a pending `/reasoning <level>` override. Asks the small model for the level for unclear tasks (default), for every task, or never (AI classification). |
| `turn.step` (main conversation only) | Decides the level on the turn's first request, then sends **every request of the turn** with that `effort` (`next({ ...e, effort })`). Subagent requests, models without effort and an active effort-cycle pick pass through unchanged. |
| `turn.complete` | Adds the turn's output-token count to the cost overview (counts only) and forgets the turn's in-memory data. |
| `tool.call` (all tools) | Observes results only: three failed calls in one task raise the effort (escalation). It always returns what the tool returned. |
| `tool.call` (`request_more_reasoning`) | Answers this mod's own escalation tool. |
| `state.set` (effort-cycle `base`) | Only with effort-cycle installed: while this mod is changing a request's effort, it keeps effort-cycle's record of the engine's own level correct, so a Ctrl+↑/↓ pick is not dropped. It changes nothing else. |
| `command.run` (`/reasoning`) | Status, one-time overrides and the setting changes listed above. |
| `ui.render` (`PromptHint`) | Terminal: draws the status line at the left of the hint line under the prompt (`Mode ◆ AUTO  ·  Reasoning ▰▰▰▱▱ HIGH  ·  Limit MAX`), followed by Claude Code's own hint. |
| `ui.render` (`AbovePrompt`) | Desktop app: draws the same line, as plain text, at the left of the band above the input; what other plugins put in that band stays. |
| `ui.press` (`PromptHint`) | A click on the status line in the terminal: the mode opens the settings pane, the reasoning meter picks the next task's level. |
| `ui.render` / `ui.press` (pane `reasoning-settings`) | Draws the settings pane and writes the pressed choice to the mod's own `/config` row. |

The mod also reads (never writes) effort-cycle's `override` state, to let your Ctrl+↑/↓ pick win.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The 168 tests in `tests/` cover:

- the reference tasks (in English, German, Spanish, French, Russian, Chinese and Japanese, plus spot checks in Portuguese, Italian, Dutch, Polish and Korean),
- keyword robustness,
- overrides, unsupported levels and model families,
- user profiles, hysteresis and escalation,
- settings persistence and the UI (clicks on the status line, hiding it),
- rules, project profiles, learning from overrides and the cost overview,
- the effort-cycle interplay,
- the effort actually sent on each request.

To try a local checkout: `claude --plugin-dir .`

## License

[MIT](LICENSE)
