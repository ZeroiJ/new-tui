# cursor-opencode

Cursor CLI look. OpenCode engine underneath.

A Bun + TypeScript TUI that pixel-matches `cursor-agent`'s interactive terminal
(header, flat grey input box, friendly model label + context %, `?` hints,
`/` command popup) but talks to the **opencode v2 background service**
(`opencode2`, API `2.0.8`) via `@opencode/client` — sessions, streaming,
models, agents, permissions, MCP.

## Run

```bash
git clone https://github.com/ZeroiJ/new-tui.git
cd new-tui
bun install
bun src/main.ts                  # interactive TUI in current dir
bun src/main.ts --workspace /tmp # choose workspace
bun src/main.ts "initial prompt" # start with a prompt
bun src/main.ts -p "review this" # print mode (no TUI, like `agent -p`)
```

Flags: `--mode plan|ask`, `--plan`, `--continue`/`-c`, `--resume <id>`,
`--model <provider/model>`, `--workspace <dir>`, `--trust` (accepted, no-op).

Requires the opencode v2 service (this repo uses `opencode2`, **not** the old
`opencode` 1.x binary):

```bash
opencode2 service status  # must print a http://127.0.0.1:... URL
```

## Looks like cursor-agent (verified side-by-side via tmux captures)

```
  Opencode
  v2.0.15
  Tip: Type ? in the prompt bar to show in-app hints.

  → Plan, search, build anything
  Space Bunny Free · 1.1%
  ~/new-tui
```

Top-anchored flow, flat plain-grey input box (no `▄`/`▀` bars), visible block
cursor parked in the box, `~`-shortened cwd, no footer by default (only
transient permission/status), reasoning hidden from the transcript.

## Micro-interactions (cursor-style)

| Feature | What you see |
|---|---|
| Thread line | dim `│` from the prompt block down the turn, closing with `└` |
| Prompt block | full-bleed filled block (`rgb(36,36,40)`) instead of a `●` bullet |
| Tool timer | `$ cmd  90ms → 4s → 1m35s`, frozen when the call ends |
| Collapsible output | `… 6 output lines hidden · ctrl+o to expand` + last 2 lines; **ctrl+o** toggles |
| Status line | green spinner + bold `Running` + dim eased token count |
| Box hints | right-aligned `ctrl+c to stop` while streaming; placeholder becomes `Add a follow-up` after the first turn |
| Context % | `Space Bunny Free · 1.1%` from the newest assistant message's `input + cache.read` over `ModelInfo.limit.context` |
| Inline code | `` `git status` `` tinted `rgb(168,181,230)`, backticks stripped |
| Completion stamp | `✓ done in 7.6s · 389 tokens`, fades after ~3s |
| Token tick-up | the count eases up to its real value instead of jumping |
| Streaming cursor | inverse block at the end of live text |

## Keys

| Key | Action |
|---|---|
| `?` + Enter | toggle hints (same grid as cursor) |
| `/` | slash-command popup (Tab completes, ↑/↓ navigates) |
| `!cmd` | run shell locally, show output as tool msg |
| `@file …` | attach files, send as context |
| `& task` | cloud-handoff note → continues locally |
| Shift+Tab | cycle Agent → Plan → Ask |
| Shift+Enter / Alt+Enter | newline in input |
| Esc | close popup / interrupt streaming |
| Ctrl+L | clear screen |
| Ctrl+G | edit input in `$EDITOR` |
| Ctrl+O | expand/collapse tool output |
| Ctrl+R | review working-tree changes (diff overlay) |
| Ctrl+C (streaming) | interrupt opencode turn |
| Ctrl+C ×2 (empty) | quit |
| ↑/↓ | history / popup navigation |

## Slash commands

`/model`, `/agent`, `/plan`, `/ask`, `/compact`, `/fork`, `/new`, `/ls`,
`/resume`, `/clear`, `/goal`, `/add-dir`, `/mcp`, `/sandbox`,
`/run-everything` (auto-approve toggle), `/auto-review`, `/diff`, `/help`, `/quit`

Permission prompts: `[a]` allow once, `[A]` always, `[d]` reject.
`/run-everything` auto-allows them.

## How it maps to opencode

| Cursor concept | opencode v2 API |
|---|---|
| prompt submit | `session.prompt({sessionID, text, model?, agent?})` |
| streaming | `event.subscribe` (deltas/status) + `message.list` poll fallback |
| interrupt | `session.interrupt` |
| sessions | `session.list/create/fork/compact`, `message.list` |
| models/agents | `model.list`, `agent.list` |
| approvals | `permission.reply` (`once`/`always`/`reject`) |
| MCP | `mcp.list` (via `/mcp` note) |

## Troubleshooting

- Use `opencode2` (v2.0.8, matches the background service). The `opencode`
  1.18.x binary speaks a different API and `run --format json` fails against
  the v2 service.
- OpenCode free-tier models only answer from inside OpenCode clients (this TUI
  counts — it uses `Service.ensure()` auth like the official TUI).
- Keystrokes typed during the ~5s connect phase are buffered and replayed.
