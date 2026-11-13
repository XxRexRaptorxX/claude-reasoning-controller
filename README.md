<p align="center"><img src=".claude-plugin/icon.png" alt="Adaptive Reasoning Controller logo" width="160"></p>

# Adaptive Reasoning Controller for Claude Code

A Claude Code mod that picks the right **effort level** (`low`, `medium`, `high`, `xhigh`, `max`) for every task and **actually sends it with each model request**. It does not add "think harder" hints to the prompt.

The goal is not maximum reasoning. The goal is the effort a task needs: quick answers stay fast and cheap, and hard debugging, large refactors or security reviews get the depth they deserve.

> **Language:** the mod's interface (status line, notices, `/reasoning` output) is in **German**. Full German documentation: [docs/README.de.md](docs/README.de.md).

```
Reasoning · AUTO | Currently · HIGH | Max Limit · MAX
```

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

1. **Local task analysis (no extra model call):** each task is scored 0–3 on seven dimensions: complexity, scope, error-proneness, correctness demand, autonomy, ambiguity and verification effort. The task type gives base values; the wording and the structure of the prompt (file references, numbered steps, stack traces) adjust them. Single keywords never decide on their own. Scope only counts in proportion to how hard the work is, so a long but simple list stays `low` while a short but hard proof gets at least `high`.
2. **Selection strategy:** it starts from the session's own level (`/effort` or the model default). It lowers that level only for clearly simple tasks and uses `xhigh`/`max` only with structural justification. Close calls keep the previous level (hysteresis). Long conversations are not stepped down by a single level, to protect the prompt cache. Follow-ups such as "ok, continue" keep the current level.
3. **Model-aware:** it knows which levels each model family takes and picks the nearest supported level. For example, `xhigh` becomes `high` on Opus 4.6. Models without effort support are left untouched.
4. **Escalation (optional):** after three failed tool calls in one task, or when Claude calls the `request_more_reasoning` tool, the rest of the task runs one level higher, within your maximum.

## Usage

| Command | Effect |
|---|---|
| `/reasoning` | Status, last decision, statistics |
| `/reasoning high` | `high` for the **next task only**; takes precedence over AUTO and min/max |
| `/reasoning max <task>` | Set the level and submit the task at once |
| `/reasoning auto` | Discard a pending override |
| `/reasoning mode auto\|balanced\|quality\|speed\|manual` | Working mode |
| `/reasoning max-level medium\|high\|xhigh\|max` | Upper limit |
| `/reasoning min-level low\|medium\|high` | Lower limit |
| `/reasoning priority efficiency\|balanced\|quality` | Cost/time priority |
| `/reasoning manual session\|low…max` | Level in MANUAL mode (`session` = leave `/effort` alone) |
| `/reasoning escalation on\|off` · `display on\|off` · `ai on\|off` | Toggles |
| `/reasoning settings` | Settings pane |

All settings are stored in `settings.json` (under `pluginConfigs`) and appear as rows in `/config`.

| Setting | Default |
|---|---|
| Mode: AUTO, BALANCED (no MAX), QUALITY FIRST, SPEED FIRST, MANUAL | AUTO |
| Max level | MAX (used only when clearly justified) |
| Min level | LOW |
| Cost/time priority | Balanced |
| Automatic escalation | on |
| Show decision before each task | on |
| AI classification (small model, only for unclear prompts) | off |

## Works with effort-cycle

When [effort-cycle](https://github.com/Anerco/claude-code-effort-cycle) is installed, a level you pick with **Ctrl+↑/↓ always wins**. While that pick is active, requests pass through untouched. The mod also keeps effort-cycle's record of the engine level correct, so your pick is not dropped, whatever the load order of the two plugins.

## Limits

- On models that take effort **per message** (`CLAUDE_CODE_MODEL_CAPABILITIES=per_turn_effort`), a mid-task escalation applies from the next user message.
- On models that take effort per request (the default), changing the level between tasks invalidates the messages prompt cache. That is why the mod avoids needless switches.
- Subagents keep their own effort, as their definitions set it.
- Organization policy, the `maxEffortLevel` setting and model capabilities still apply on top.
- The function-hooks mod API is early access and may change between Claude Code releases.

## Privacy

- **No prompt text is stored.** Session state holds only task traits. The persistent store holds counts only (levels, escalations, overrides).
- No extra model calls unless you enable the optional AI classification. That sends the first 4,000 characters of an unclear prompt to Claude Code's small, fast model.
- The only thing the model sees from this mod is the short description of the escalation tool, and only while escalation is enabled.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The 61 tests in `tests/` cover:

- the reference tasks,
- keyword robustness,
- overrides, unsupported levels and model families,
- user profiles, hysteresis and escalation,
- settings persistence and the UI,
- the effort-cycle interplay,
- the effort actually sent on each request.

To try a local checkout: `claude --plugin-dir .`

## License

[MIT](LICENSE)
