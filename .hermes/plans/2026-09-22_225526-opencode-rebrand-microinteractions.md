# Opencode Rebrand + Cursor Micro-Interactions Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Rebrand the TUI from "Cursor Agent" to "Opencode" with the real opencode version in the header and the real selected model under the prompt bar, then port the full set of cursor-agent micro-interactions (live token streaming, status spinner, tool lines, permission menu overlay, model picker).

**Architecture:** Pure render-layer + event-pump changes in the existing raw-ANSI TUI. State (`UIState` in `src/ui.ts`) gains a few fields; `src/main.ts`'s `eventPump` upgrades from "status hints only" to a live stream reducer (text deltas, tool lines, usage, permissions, model switches); `src/backend.ts` gains `getServerInfo()` / `getDefaultModel()` / `switchModel()`. The existing message-poll loop stays as the reconciliation fallback (it is the safety net when events are missed).

**Tech Stack:** Bun + TypeScript, `@opencode/client@2.0.8` (Promise client + `Service.ensure()`), raw ANSI rendering (no TUI framework), tmux for verification captures.

---

## Current Context / Assumptions

- Working dir: `/home/zeroij/new-tui`. Files: `src/ui.ts` (renderer/state, 324 lines), `src/main.ts` (loop/commands/submit/eventPump, ~576 lines), `src/backend.ts` (client wrapper, ~180 lines).
- Background service: `opencode2` v2.0.8 at `http://127.0.0.1:49374` (verify with `opencode2 service status`).
- Header currently: `Cursor Agent` / hardcoded `v2026.09.18-cursor-look` (`CURSOR_VERSION_LABEL`, `src/main.ts:6`).
- Model line under box currently: hardcoded `Auto` (`src/ui.ts:131` `modelLabel`), rendered at `src/ui.ts:226`.
- Verified API shapes (from `node_modules/@opencode/client/dist/promise/generated/types.d.ts`):
  - `server.info` op → `client.server.info()` returns `{version, pid, urls, paths}` (openapi operationId `server.info`; fallback `GET /api/info`).
  - `model.default()` → `{location, data: ModelInfo|null}`, `ModelInfo` has `id`, `modelID`, `providerID`, `name` (e.g. `"MiMo-V2.6-Flash Free"`), `family`.
  - `session.get({sessionID})` → `SessionInfo` incl. `model: {id, providerID, variant?}`.
  - `session.switchModel({sessionID, model:{id, providerID, variant?}})`.
  - Events (via `event.subscribe`): `session.text.delta` `data:{sessionID, assistantMessageID, ordinal, delta}`; `session.usage.updated` `data:{sessionID, cost, tokens}`; `session.tool.called` `data:{sessionID, assistantMessageID, id, input, executed}`; `session.status` `data:{sessionID, status}`; `session.model.selected`; `session.execution.started|succeeded|failed|interrupted` `data:{sessionID}`; `permission.asked` `data:{id, sessionID, action, resources, save?, message?}`.
  - `permission.reply({sessionID, requestID, decision})` where decision ∈ `"once"|"always"|"reject"`.
- **Note:** current `eventPump` in `src/main.ts` reads `ev["properties"] ?? ev["data"]` — v2 events use `.data`. It works only because it also checks `type.includes(...)`. New code should read `ev.data` only.
- cursor-agent live behaviors captured in tmux (the spec for this plan):
  1. Status line above box: `⠘⠤ Working` → `⠠⠛ Running  58 tokens` (spinner + phase + live output-token count), disappears when idle.
  2. Assistant prose streams inline: `  Creating the file, then listing /tmp.`
  3. Tool lines: `    Editing mi-test.txt` while running → `    Edited mi-test.txt +1` done → diff gutter preview `    ▎+ hello`.
  4. Shell tool: ` $ ls /tmp | head 0ms` (`$ cmd duration`), pending: ` $ ls /tmp | head Waiting for approval...`.
  5. Permission overlay: full-width `────…` divider, then ` $  ls /tmp | head in .`, ` Run this command?`, ` Not in allowlist: head`, menu `  → Run (once) (y)` / `    Add Shell(head) to allowlist? (tab)` / `    Run Everything (shift+tab)` / `    Skip & tell the agent what to do instead (esc or n)`; bottom-right dim `ctrl+r to review changed files`.
  6. Below box: model/mode label line, then `~`-short cwd.
  7. `1 task` pending-queue line under box (opencode analog: inbox queue length — stretch).
  8. `/model` opens a filterable arrow-navigable picker (`/model [filter]  Select model (Tab to edit)`).
  9. Slash popup: fixed two-column alignment (name padded, desc column), `→` on selection, `↓ more below` after 8.
- Repo is **not** a git repo (harness reported "Is directory a git repo: no"). Task steps say "commit" → first run `git init` once (Task 0) so work is recoverable; if the user objects, drop commits but keep task boundaries.

---

## Task 0: Init git for recoverable checkpoints

**Objective:** Version control so each task can be reverted independently.

**Files:** none (repo root `/home/zeroij/new-tui`)

**Step 1:**
```bash
cd /home/zeroij/new-tui && git init && printf 'node_modules/\ndist/\n*.log\n.DS_Store\n' > .gitignore && git add -A && git commit -m "chore: checkpoint before opencode rebrand"
```
Expected: `[master (root-commit) ...] chore: checkpoint before opencode rebrand`

---

## Task 1: Header → "Opencode" + real version

**Objective:** Title reads `Opencode`; second line shows the live opencode service version (e.g. `v2.0.8`), not a fake Cursor build id.

**Files:**
- Modify: `src/backend.ts` (add `getServerInfo`)
- Modify: `src/main.ts:6,74` (drop `CURSOR_VERSION_LABEL`, fetch real version before `createState`)
- Modify: `src/ui.ts` header block (already `Cursor Agent` → change label source only; text is in `render()`)

**Step 1 — backend:**
```ts
// src/backend.ts, add after getServerUrl()
export async function getServerInfo(): Promise<{ version?: string } | null> {
  try {
    const cl = (await c()) as unknown as { server?: { info: () => Promise<unknown> } };
    if (cl.server?.info) return unwrap(cl.server.info()) as { version?: string };
  } catch { /* fall through */ }
  try {
    const cl = await getClient();
    const r = await fetch(new URL("/api/info", (await getClient(), getServerUrl())), {
      headers: await (await import("@opencode/client/service")).Service.headers(_endpoint as never),
    });
    return (await r.json()) as { version?: string };
  } catch { return null; }
}
```
(Implementer: prefer `client.server.info()` if it type-checks — grep `node_modules/@opencode/client/dist/promise/generated/client.d.ts` line ~14 `server: {` for the exact method; the fetch path is the fallback.)

**Step 2 — main:** before `createState`, `const info = await BE.getServerInfo(); const version = info?.version ?? "unknown";` pass as 2nd arg; delete `CURSOR_VERSION_LABEL`.

**Step 3 — ui:** in `render()`, header stays:
```
  Opencode
  v2.0.8            ← dim(s.version) as today
```
(s.version already rendered `v${s.version}` — no structural change.)

**Verify:**
```bash
tmux new -d -s v -x 120 -y 32 && tmux send-keys -t v "cd /home/zeroij/new-tui && bun src/main.ts --workspace /tmp" C-m && sleep 7 && tmux capture-pane -t v -p | sed -n '1,6p'
```
Expected first lines: `  Opencode` then `  v2.0.8` (dim).

**Commit:** `git commit -am "feat: opencode header with real service version"`

---

## Task 2: Real model label under the prompt bar

**Objective:** The line under the box shows the model opencode will actually use (e.g. `MiMo-V2.6-Flash Free`), refreshed from `session.get`, `model.default()`, `session.model.selected` events, and `/model` — mode-aware (`Plan · <model>` / `Ask · <model>`).

**Files:**
- Modify: `src/backend.ts` (add `getDefaultModel`, `switchModel`)
- Modify: `src/ui.ts:107-153` (`modelLabel` semantics: `""` = resolve-at-render fallback), `src/ui.ts:226` (render line)
- Modify: `src/main.ts` (init from session, `/model` handler, `eventPump` model event)

**Step 1 — backend:**
```ts
export async function getDefaultModel(): Promise<string | null> {
  try {
    const cl = (await c()) as unknown as { model: { default: (o?: unknown) => Promise<unknown> } };
    const m = unwrap<{ data?: { name?: string; modelID?: string; id?: string } | null }>(await cl.model.default());
    const d = m?.data;
    return d ? (d.name ?? d.modelID ?? d.id ?? null) : null;
  } catch { return null; }
}
export async function switchModel(sessionID: string, model: { providerID: string; id: string; variant?: string }) {
  const cl = (await c()) as unknown as { session: { switchModel: (o: unknown) => Promise<unknown> } };
  await cl.session.switchModel({ sessionID, model });
}
```

**Step 2 — main init (after session ready):** `const sess = await BE.getSession(sessionID);` → `s.modelLabel = sess.model ? String(sess.model.id) : (await BE.getDefaultModel()) ?? "Auto";`

**Step 3 — render (`src/ui.ts:226`):**
```ts
const label = s.mode === "agent" ? s.modelLabel
  : s.mode === "plan" ? `Plan · ${s.modelLabel}`
  : `Ask · ${s.modelLabel}`;
tail.push(`  ${dim(label)}`);
```

**Step 4 — `/model` without arg:** keep picker list (Task 7). With arg `provider/id`: call `BE.switchModel(sessionID, {providerID, id})`, set `s.modelLabel` to friendly name (look up in `listModels()` by `id`), transcript note.

**Step 5 — eventPump:** on `session.model.selected` (data has sessionID + model ref — grep the type for exact field names before coding), update `s.modelLabel`.

**Verify:** tmux run → below box shows `MiMo-V2.6-Flash Free` (dim), not `Auto`. Then in-UI: `/model opencode/claude-haiku-4-5` → label switches; confirm server-side via `opencode2 session list` model column if available.

**Commit:** `git commit -am "feat: real model label under prompt bar"`

---

## Task 3: Live token streaming (assistant text renders as it arrives)

**Objective:** Assistant reply streams into the transcript word-by-word via `session.text.delta`, instead of appearing only after the 1.5s poll sees a finished message.

**Files:**
- Modify: `src/main.ts` `eventPump` (delta reducer) + `submit()` (dedupe vs poll)

**Design:**
- `eventPump` on `session.text.delta`:
  ```ts
  const { assistantMessageID, delta } = props;
  // maintain: streamingMsgByOrid = Map<string /*assistantMessageID*/, {seq: number}>
  // append delta to the LIVE assistant transcript entry:
  ensureLiveAssistant(s);        // creates s.transcript entry {role:"assistant", text:""} if none open
  s.liveAssistantId = assistantMessageID;
  s.transcript[last].text += delta;
  s.streaming = true;
  ```
  Track per-`assistantMessageID` `ordinal` high-water mark; drop out-of-order/duplicate ordinals (`if (ordinal <= seen) return;`).
- `submit()` poll reconciliation must NOT double-render: pass the live `assistantMessageID`s seen during streaming into `merge()`; when merging an assistant message whose id was streamed, replace the live entry's text with the authoritative message text (final sync) instead of appending.
- New `UIState` fields: `liveAssistantId: string | null` + `seenOrdinals: Map<string, number>` (reset per submit).

**Verify (tmux):** send `write a 3-sentence poem` → text must visibly grow between two captures 1s apart (poll-only would show nothing then everything):
```bash
tmux send-keys -t v "write a 3 sentence poem" C-m; sleep 6; tmux capture-pane -t v -p > /tmp/a.txt; sleep 1; tmux capture-pane -t v -p > /tmp/b.txt; diff /tmp/a.txt /tmp/b.txt && echo "NO STREAM" || echo "streaming OK"
```
Expected: `streaming OK`, final text appears exactly once (grep -c the last line == 1).

**Commit:** `git commit -am "feat: live assistant token streaming"`

---

## Task 4: Status line — spinner + phase + token count

**Objective:** Line above the input box shows cursor-style status while a turn runs: `⠋ Working` (waiting for first token) → `⠙ Running  1234 tokens` (executing, from `session.usage.updated`), hidden when idle.

**Files:**
- Modify: `src/ui.ts` `UIState` (add `phase: "idle"|"working"|"running"`, `turnTokens: number`), `render()` (status row above `boxTopIdx`)
- Modify: `src/main.ts` `eventPump` (set phase/tokens), `submit()` (set `working` on send, `idle` on settle — already sets `s.streaming`)

**Render (insert into `tail` immediately before the box top row):**
```ts
if (s.streaming) {
  const label = s.phase === "working" ? "Working"
    : `Running  ${s.turnTokens > 0 ? s.turnTokens.toLocaleString() + " tokens" : ""}`.trim();
  tail.push(dim(`  ${SPINNER[s.spinner % SPINNER.length]} ${label}`));
}
```
Spinner frames array already exists (`SPINNER` in `src/ui.ts`); tick at 120ms already exists.

**eventPump mappings:**
- `session.execution.started` → `phase = "running"`
- first `session.text.delta` → `phase = "running"` (tokens phase), keep `streaming = true`
- `session.usage.updated` → `turnTokens = data.tokens.output` (grep `export type TokenUsageInfo` for exact field; fall back to sum of numeric fields)
- `session.execution.succeeded|failed|interrupted`, `session.idle` → `streaming = false`, `phase = "idle"`
- `submit()` entry → `phase = "working"; turnTokens = 0`

**Verify:** tmux: during a run, capture shows `⠋ Working` then `⠙ Running  N tokens`; after completion line is gone.

**Commit:** `git commit -am "feat: cursor-style status line with live token count"`

---

## Task 5: Tool lines (live) in cursor style

**Objective:** Tool activity renders as indented transcript lines like cursor: running → `    Editing mi-test.txt`, done → `    Edited mi-test.txt +1`, shell → ` $ ls /tmp | head 0ms`.

**Files:**
- Modify: `src/ui.ts` transcript renderer (add `role: "tool"` formatting variants + `state` on TranscriptItem)
- Modify: `src/main.ts` `eventPump` (tool.called → create/update live tool line; tool.success → finalize)
- Modify: `src/backend.ts` `extractText` (replace `[tool:name]` bracket form with cursor-style one-liners when rendering history)

**Data reality:** `session.tool.called` has `input` but **no top-level tool name** — the name lives in the assistant message content parts (`{type:"tool", name, ...}`) and/or `state`. Implement: maintain `toolNameById: Map<string,string>` refreshed from the poll (`listMessages` parts have `id` + `name`); on `tool.called`, line = `    ${input.filePath ?? input.command ?? input.description ?? "Running tool…"}`; when `tool.success`/`tool.failed` arrives, finalize to `    ✓ ${summary}` / `    ✗ ${error}`. Shell-ish tools (name contains `shell|bash|exec`) render ` $ ${input.command}` prefix.

**History rendering (`extractText` in backend):** keep tool parts but emit structured text the renderer styles — simplest contract: tool part → line `⏺ ${name} ${state === false ? "queued" : "done"}` and let `role:"tool"` dim it (already indented 4 in cursor style — change prefix in `render()` from `  ⏺ ` to `    ` for tool role, and shell lines keep ` $ `).

**Verify:** tmux: send `create /tmp/mi-test.txt with content hi and cat it` → capture during run shows indented tool lines updating; after: file exists (`ls /tmp/mi-test.txt`).

**Commit:** `git commit -am "feat: cursor-style live tool lines"`

---

## Task 6: Permission overlay (cursor menu)

**Objective:** Replace the one-line footer permission notice with cursor's full overlay: divider, context, question, arrow menu, keyboard shortcuts — and `Waiting for approval...` inline on the pending shell line.

**Files:**
- Modify: `src/ui.ts` `UIState.permission` shape + `render()` overlay block (renders *above* footer, full width)
- Modify: `src/main.ts` permission key handling (y / tab / shift+tab / esc / n)

**State shape:**
```ts
permission: { id: string; action: string; resources: string[]; message?: string; hasSave: boolean } | null
```
(eventPump `permission.asked` → fill from `data.action`, `data.resources`, `data.message`, `hasSave = (data.save?.length ?? 0) > 0`)

**Render (cursor-exact):**
```ts
if (s.permission) {
  tail.push(dim("─".repeat(s.cols - 2)));
  tail.push(` $  ${s.permission.resources[0] ?? s.permission.action}`);
  tail.push(` ${s.permission.action.replace(/_/g, " ") || "Allow this?"}`);
  if (s.permission.resources[0]?.length) tail.push(dim(` Not in allowlist: ${lastToken(s.permission.resources[0])}`));
  tail.push(`  ${bold("→")} Run (once) ${dim("(y)")}`);
  if (s.permission.hasSave) tail.push(dim(`    Add ${s.permission.resources[0]} to allowlist? (tab)`));
  tail.push(dim(`    Run Everything (shift+tab)`));
  tail.push(dim(`    Skip & tell the agent what to do instead (esc or n)`));
  // bottom-right hint, right-aligned:
  tail.push(rightAlign(dim("ctrl+r to review changed files"), s.cols));
}
```
(Key wording: adapt `Run this command?` for shell actions, `Allow this tool?` otherwise — cursor's exact strings above for shell.)

**Keys (replace current a/A/d block in `handleKey`):**
- `y` → `replyPermission(..., "once")`
- `tab` → `"always"` (save-to-allowlist)
- `shift+tab` → `"always"` + `autoApprove = true` (Run Everything)
- `esc` or `n` → `"reject"` (this also cancels streaming visually)
- keep `a` as alias for `y` (old muscle memory), `d` alias for reject.

**Inline pending state:** while `permission != null`, the tool/shell transcript line reads ` $ cmd Waiting for approval...` (set via tool-line updater).

**Verify:** tmux: send `run: echo hi && sleep 1 && echo done` with `/run-everything` OFF → overlay appears with divider + menu; press `y` → command output appears; press `n` on a second request → agent reports denied. Also `tab` persists (second identical command does NOT prompt).

**Commit:** `git commit -am "feat: cursor-style permission overlay"`

---

## Task 7: Model picker popup (filterable, arrow-navigable)

**Objective:** `/model` opens a cursor-style picker: input stays `/model <filter>`, popup lists matches with `→` cursor, ↑/↓ navigate, Enter picks (calls `switchModel`), Tab completes model id.

**Files:**
- Modify: `src/ui.ts` (reuse slash-popup rendering path — generalize `slashOpen/slashFilter/slashIndex` → `popup: {kind:"slash"|"model", filter, index, items}`) 
- Modify: `src/main.ts` `/model` handling (no-arg → open picker instead of dumping list)

**Implementation:**
- On `/model` (no arg): `s.popup = {kind:"model", filter:"", index:0, items: await BE.listModels()}` (items: `{label: d.name ?? d.id, value: `${d.providerID}/${d.id}`}`).
- While popup open: chars append to filter (replace filter segment after `/model `), ↑/↓ move `index`, Enter → `switchModel` + set `modelLabel` + close, Tab → insert `items[index].value` into input, Esc → close.
- Render: same two-column layout as slash popup (Task 9 alignment), header dim `/model [filter]  Select model (Tab to edit)`.

**Verify:** tmux: `/model` → picker lists ≥7 models with `→` on first; type `haiku` → filtered; Enter → under-box label changes; `opencode2` model actually switched (send a message, check session via `opencode2 session list` shows new model if column present, else `session.get`).

**Commit:** `git commit -am "feat: filterable model picker"`

---

## Task 8: Slash popup alignment + polish

**Objective:** Two-column fixed-width popup like cursor (`/name` padded to column 30, description aligned), `↓ more below` after 8 rows, no jitter when filtering.

**Files:**
- Modify: `src/ui.ts` slash popup render block (currently inline `label = name + "  " + desc`)

```ts
const NAME_W = 30;
const label = c.name.padEnd(NAME_W) + c.desc;
// selected: `   ${bold("→")} ${bold(c.name)} ${dim(rest)}` → simpler: keep line but pad
```
Verify visually vs cursor capture (columns align at same x for all rows).

**Verify:** tmux capture of `/` popup: desc column aligned; scroll past 8 shows `↓ more below`; ↓ wraps or clamps (pick clamp, cursor clamps).

**Commit:** `git commit -am "feat: aligned slash popup"`

---

## Task 9: Extras (stretch — only if time): `ctrl+r` diff view + task counter

**9a. `ctrl+r`:** open a full-screen diff overlay using `vcs.diff` (backend add `vcsDiff()` → operation `vcs.diff`), scroll with ↑/↓, Esc closes. Render as dim/green/red lines.
**9b. Task counter:** below box show `${session.inbox.list().length} task` when > 0 (operation `session.inbox.list`).

Each verified separately; commit separately.

---

## Cross-Cutting Validation (after all tasks)

1. Type-check: `cd /home/zeroij/new-tui && bunx tsc --noEmit` → no output.
2. Full tmux script:
```bash
tmux kill-server 2>/dev/null; tmux new -d -s f -x 130 -y 44
tmux send-keys -t f "cd /home/zeroij/new-tui && bun src/main.ts --workspace /tmp" C-m
sleep 7
tmux capture-pane -t f -p | sed -n '1,10p'     # Opencode / v2.0.8 / tips / box / model / ~/new-tui
tmux send-keys -t f "create /tmp/e2e.txt with hi, cat it, then say DONE" C-m
sleep 4;  tmux capture-pane -t f -p | grep -E "Working|Running"   # status line
sleep 12; tmux capture-pane -t f -p | grep -E "e2e|DONE|cat"        # tool lines + reply
tmux send-keys -t f "/" ; sleep 1; tmux capture-pane -t f -p | grep -E "→ /model|↓ more"  # popup
tmux kill-server
```
3. Side-by-side eyeball vs the original cursor-agent capture (same tmux size 130x44) — header, status line, tool lines, permission overlay, model line.
4. Regression: `?` hints, `!` shell, `@files`, Shift+Tab modes, Esc interrupt, Ctrl+C quit, `/help`, `/ls`, `/resume` still work (walk through manually once).

## Risks / Tradeoffs / Open Questions

- **Event shape drift:** all event handling reads `ev.data`; if a field name differs (e.g. `session.model.selected` payload), grep exact type in `node_modules/@opencode/client/dist/promise/generated/types.d.ts` before coding — types are the contract, don't guess.
- **No tool name in `tool.called`:** solved via poll-refreshed `toolNameById` map; a tool whose name never appears in a poll renders generic `Running tool…` (acceptable).
- **Token count meaning:** cursor shows small per-turn output tokens; opencode `usage.updated` may be cumulative session tokens. Prefer `tokens.output` delta per turn if cumulative (store baseline at submit).
- **Free-tier latency:** first token can take 5–30s (observed). Status line `Working` covers this gap — do not remove the poll fallback.
- **`ctrl+r` diff / task counter** are stretch; ship core Tasks 1–8 first.
- Open question for user: model line — show friendly name (`MiMo-V2.6-Flash Free`, cursor-like) or full id (`opencode/mimo-v2.6-flash-free`, opencode-TUI-like)? Plan assumes friendly name; trivial to switch.
