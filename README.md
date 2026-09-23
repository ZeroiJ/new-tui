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

### Install it as a command

Like `opencode`, it runs against whatever directory you're in — that directory
becomes the agent's workspace. Drop a wrapper on your PATH:

```bash
# ~/.local/bin/ctui
#!/usr/bin/env bash
set -euo pipefail
exec /home/you/.bun/bin/bun /path/to/new-tui/src/main.ts "$@"
```

```bash
chmod +x ~/.local/bin/ctui
ctui                  # workspace = current directory
ctui --workspace /tmp # explicit workspace
ctui -p "review this" # print mode
```

The wrapper deliberately does *not* take the name `opencode` — that would
shadow the real opencode CLI.

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

## Thinking animations

The status line's thinking indicator is a set of terminal ports of the
[loading.dev](https://loading.dev) designs (MIT © Jakub Krehel & Paul
Faivret). The originals are React + CSS-keyframe SVG components, so these are
re-implementations of the same motion — same cycle durations from their
`SPINNER_MOTION` table, drawn as single-line cell animations.

`/spinner` lists them, `/spinner <name>` switches:

| Name | Cycle | Look |
|---|---|---|
| `linear-dots` *(default)* | 900ms | three dots fading in sequence |
| `wave` | 900ms | five bars rising and falling |
| `bouncing-dots` | 500ms | staggered bounce |
| `leap` | 1800ms | the last dot leaps to the front |
| `classic` | 1200ms | quadrants stepping with a fading trail |
| `circular-dots` | 800ms | the brightest dot hops the ring |
| `morph` | 1200ms | a square rounding into a circle |
| `ripple` | 1200ms | a dot rippling outward |
| `swirl` | 1200ms | a bright cell chasing its trail |
| `cursor` | 1200ms | the original cursor-agent braille spinner |

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
`/run-everything` (auto-approve toggle), `/auto-review`, `/spinner`,
`/diff`, `/help`, `/quit`

Commands opencode itself provides (built-in and project
`.opencode/command/*.md`) are listed first and run server-side through
`session.command`; this TUI's own commands follow as extras. The list
refreshes live on the `command.updated` event.

Permission prompts: `[a]` allow once, `[A]` always, `[d]` reject.
`/run-everything` auto-allows them.

## How it maps to opencode

| Cursor concept | opencode v2 API |
|---|---|
| prompt submit | `session.prompt({sessionID, text, model?, agent?})` |
| slash commands | `command.list` + `session.command` (opencode's own commands run server-side) |
| streaming | `event.subscribe` (deltas/status) + `message.list` poll fallback |
| interrupt | `session.interrupt` |
| sessions | `session.list/create/fork/compact`, `message.list` |
| models/agents | `model.list`, `agent.list` |
| approvals | `permission.reply` (`once`/`always`/`reject`) |
| MCP | `mcp.list` (via `/mcp` note) |
| server→TUI | `tui.command.execute`, `tui.toast.show`, `tui.session.select`, `tui.prompt.append` |

## Architecture

Modules mirror opencode's own concepts rather than a flat grab-bag:

```
src/
  main.ts          entry: arg parsing, -p print mode
  app.ts           controller: bootstrap, keys, turn loop, event pump, timers
  state.ts         UIState + the opencode message/part store
  commands.ts      slash-command registry (opencode's merged with local)
  slash.ts         local slash-command implementations
  tips.ts          header tips + hints panel
  spinners.ts      loading.dev-style thinking animations

  opencode/        everything that talks to the service
    client.ts      connection + low-level call surface
    session.ts     session lifecycle, prompt, command, interrupt, vcs
    message.ts     message history + token accounting
    catalog.ts     models, agents, commands, mcp, permissions
    parts.ts       opencode's part model (text/tool/reasoning/file/step)
    events.ts      event → state dispatch table + server→TUI commands
    index.ts       barrel

  ui/              everything that draws
    render.ts      frame assembly + cursor parking
    transcript.ts  prompt blocks, thread lines, tool lines, output collapse
    composer.ts    input box, placeholder, hints
    status.ts      status line, completion stamp, toasts
    popups.ts      slash + model popups (scrolling)
    overlays.ts    permission prompt, diff review
    theme.ts       colours and escape sequences
    text.ts        wrapping, ANSI stripping, duration formatting
    keys.ts        terminal key decoding
```

Two ideas drive the design:

- **The event pump is a dispatch table**, not an if/else chain, so adding an
  opencode event is one entry in `opencode/events.ts`.
- **opencode's data model is authoritative.** `message.list` results and tool
  events populate a real message/part store in `state.ts`; the transcript is a
  view over it, and each transcript item links back by id.

## Troubleshooting

- Use `opencode2` (v2.0.8, matches the background service). The `opencode`
  1.18.x binary speaks a different API and `run --format json` fails against
  the v2 service.
- OpenCode free-tier models only answer from inside OpenCode clients (this TUI
  counts — it uses `Service.ensure()` auth like the official TUI).
- Keystrokes typed during the ~5s connect phase are buffered and replayed.
