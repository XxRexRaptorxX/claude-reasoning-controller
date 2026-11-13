# Contributing

Issues and pull requests are welcome.

## Layout

| Path | Purpose |
|---|---|
| `hooks/lib/classifier.ts` | Local task analysis (pure, no I/O) |
| `hooks/lib/policy.ts` | Selection strategy (pure) |
| `hooks/lib/models.ts` | Effort levels per model family: add new models here |
| `hooks/lib/settings.ts` | `userConfig` parsing |
| `hooks/lib/format.ts` | User-facing text and the `/reasoning` parser |
| `hooks/ui.tsx` | Status line and settings pane |
| `hooks/register.tsx` | Hook wiring (`turn.start`, `turn.step`, `tool.call`, …) |
| `types/index.d.ts` | `$.state` contract |

## Before a pull request

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

For a type check, load the folder once with `claude --plugin-dir .`; Claude Code then writes the API declarations to `.claude-plugin/types/`. After that, run `npx tsc -p .`.

Please add a test for any change to classification or selection. A new reference prompt belongs in `tests/classifier.test.ts`.
