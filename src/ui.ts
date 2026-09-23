// Minimal raw-ANSI Cursor-style renderer + input state.
// No external TUI dep: full control over ▄/▀ input box.

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  invert: "\x1b[7m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  altOn: "\x1b[?1049h",
  altOff: "\x1b[?1049l",
  clear: "\x1b[2J\x1b[H",
};

// Cursor input-box surface: dark charcoal fill, with the ▄/▀ edge rows
// painted in the same color so the box blends in like cursor-agent.
const BOX_BG = [52, 52, 52] as const;
export function boxBg(s: string): string {
  return `\x1b[48;2;${BOX_BG[0]};${BOX_BG[1]};${BOX_BG[2]}m${s}\x1b[49m`;
}
export function shortCwd(cwd: string): string {
  const home = process.env.HOME ?? "";
  if (home && (cwd === home || cwd.startsWith(home + "/"))) return "~" + cwd.slice(home.length);
  return cwd;
}
export function dim(s: string): string {
  return `${ANSI.dim}${s}${ANSI.reset}`;
}
export function bold(s: string): string {
  return `${ANSI.bold}${s}${ANSI.reset}`;
}

export type Mode = "agent" | "plan" | "ask";

export interface TranscriptItem {
  role: "user" | "assistant" | "tool" | "system" | "error";
  text: string;
  /** opencode tool-call id (tool items only) — used for live updates */
  toolId?: string;
  /** tool timing (ms epoch) — drives the elapsed timer on the tool line */
  startedAt?: number;
  endedAt?: number;
  /** tool output lines (agent shell tools) — collapsed, ctrl+o expands */
  output?: string[];
}

export interface SlashCmd {
  name: string;
  desc: string;
}

export const SLASH_COMMANDS: SlashCmd[] = [
  { name: "/model", desc: "Select model (Tab to edit)" },
  { name: "/agent", desc: "Select agent" },
  { name: "/plan", desc: "Create a plan or show existing plan" },
  { name: "/ask", desc: "Toggle ask mode (Q&A, read-only)" },
  { name: "/compact", desc: "Compact session context" },
  { name: "/fork", desc: "Fork session from latest" },
  { name: "/new", desc: "Start a new session" },
  { name: "/ls", desc: "List sessions" },
  { name: "/resume", desc: "Resume a session by id" },
  { name: "/clear", desc: "Clear screen (Ctrl+L)" },
  { name: "/goal", desc: "Start a durable goal" },
  { name: "/add-dir", desc: "Add a directory to workspace" },
  { name: "/mcp", desc: "MCP servers status" },
  { name: "/sandbox", desc: "Toggle sandbox info" },
  { name: "/run-everything", desc: "Toggle Run Everything" },
  { name: "/auto-review", desc: "Auto-review status" },
  { name: "/diff", desc: "Show session diff" },
  { name: "/help", desc: "Show help" },
  { name: "/quit", desc: "Quit (Ctrl+C twice)" },
];

export const TIPS = [
  "Tip: Type ? in the prompt bar to show in-app hints.",
  "Tip: Use /model to switch models mid-session.",
  "Tip: Shift+Tab switches Agent / Plan / Ask.",
  "Tip: ! runs shell, @ attaches files, & moves to cloud.",
  "Tip: Powered by opencode underneath (opencode2 service API).",
];

export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= width) {
      lines.push(raw);
      continue;
    }
    let cur = "";
    for (const word of raw.split(" ")) {
      if ((cur + " " + word).trim().length > width) {
        if (cur) lines.push(cur);
        if (word.length > width) {
          for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
          cur = "";
        } else cur = word;
      } else cur = cur ? cur + " " + word : word;
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

export interface PermissionState {
  id: string;
  action: string;
  resources: string[];
  message?: string;
  hasSave: boolean;
}

export interface UIState {
  cols: number;
  rows: number;
  transcript: TranscriptItem[];
  input: string;
  cursor: number;
  mode: Mode;
  modelLabel: string;
  cwd: string;
  version: string;
  tipIndex: number;
  hintsOpen: boolean;
  slashOpen: boolean;
  slashFilter: string;
  slashIndex: number;
  /** model picker: available models (preloaded) + open state */
  modelItems: { label: string; value: string }[];
  modelOpen: boolean;
  modelIndex: number;
  streaming: boolean;
  spinner: number;
  statusMsg: string;
  scrollOffset: number;
  permission: PermissionState | null;
  cloudMsg: string | null;
  /** "working" = waiting for first token; "running" = executing/streaming */
  phase: "idle" | "working" | "running";
  /** live output-token count for the current turn (cursor-style status line) */
  turnTokens: number;
  /** animated token counter (eases toward turnTokens) */
  tokenDisplay: number;
  /** session-cumulative output tokens at turn start (baseline for turnTokens) */
  turnBaseline: number;
  /** assistant message currently streaming (from session.text.delta) */
  liveAssistantId: string | null;
  /** transcript index of the live-streamed assistant entry (merge replaces it) */
  liveAssistantIdx: number | null;
  /** per-assistantMessageID highest ordinal seen (dedupe deltas) */
  seenOrdinals: Map<string, number>;
  /** tool-call id → transcript index (live tool line updates) */
  toolLineById: Map<string, number>;
  /** tool-call id → tool name (refreshed from message polls) */
  toolNameById: Map<string, string>;
  /** ctrl+r diff overlay */
  diffOpen: boolean;
  diffLines: string[];
  diffScroll: number;
  /** pending inbox tasks (shown under box when > 0) */
  taskCount: number;
  /** true once a turn has been submitted — swaps the box placeholder */
  followUp: boolean;
  /** ctrl+o — expand collapsed tool output */
  outputExpanded: boolean;
  /** completion stamp shown for ~3s after a turn settles */
  stamp: { at: number; durMs: number; tokens: number; until: number } | null;
  /** current model's context window (from ModelInfo.limit.context) */
  contextLimit: number;
  /** context used % (from last assistant message tokens) */
  contextPct: number | null;
}

export function createState(cwd: string, version: string): UIState {
  return {
    cols: process.stdout.columns ?? 120,
    rows: process.stdout.rows ?? 36,
    transcript: [],
    input: "",
    cursor: 0,
    mode: "agent",
    modelLabel: "Auto",
    cwd,
    version,
    tipIndex: 0,
    hintsOpen: false,
    slashOpen: false,
    slashFilter: "",
    slashIndex: 0,
    modelItems: [],
    modelOpen: false,
    modelIndex: 0,
    streaming: false,
    spinner: 0,
    statusMsg: "",
    scrollOffset: 0,
    permission: null,
    cloudMsg: null,
    phase: "idle",
    turnTokens: 0,
    tokenDisplay: 0,
    turnBaseline: 0,
    liveAssistantId: null,
    liveAssistantIdx: null,
    seenOrdinals: new Map(),
    toolLineById: new Map(),
    toolNameById: new Map(),
    diffOpen: false,
    diffLines: [],
    diffScroll: 0,
    taskCount: 0,
    followUp: false,
    outputExpanded: false,
    stamp: null,
    contextLimit: 0,
    contextPct: null,
  };
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Full-bleed user-prompt block: dark charcoal fill (cursor-agent's prompt echo).
function userBlockRow(s: string, W: number): string {
  return `\x1b[48;2;36;36;40m${s.padEnd(W)}\x1b[49m`;
}

/** Tool elapsed timer: 0ms → 35s → 1m35s */
function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

// Inline `code` in assistant answers, tinted like cursor-agent.
function tint(s: string): string {
  return `\x1b[38;2;168;181;230m${s}\x1b[39m`;
}
function inlineCode(t: string): string {
  return t.replace(/`([^`\n]+)`/g, (_m, c: string) => tint(c));
}

export function render(s: UIState): string {
  const W = s.cols;
  const boxW = Math.max(20, W - 2);

  // ctrl+r diff overlay — full-screen review of working-tree changes.
  if (s.diffOpen) {
    const out: string[] = [ANSI.clear, `  ${bold("Changed files")} ${dim("(↑/↓ scroll, esc close)")}`, ""];
    const room = Math.max(3, s.rows - 4);
    const maxScroll = Math.max(0, s.diffLines.length - room);
    const scroll = Math.min(s.diffScroll, maxScroll);
    for (const ln of s.diffLines.slice(scroll, scroll + room)) {
      const c = ln.startsWith("+") ? `\x1b[32m${ln}${ANSI.reset}`
        : ln.startsWith("-") ? `\x1b[31m${ln}${ANSI.reset}`
        : ln.startsWith("@@") ? `\x1b[36m${ln}${ANSI.reset}`
        : ln.startsWith(" ") ? dim(ln)
        : ln;
      out.push("  " + (c.length > W ? c.slice(0, W) : c));
    }
    if (s.diffLines.length === 0) out.push(dim("  (no changes)"));
    return out.join("\n");
  }

  // Header — flush to top, rebranded: Opencode + real service version.
  const head: string[] = [];
  head.push("  Opencode");
  head.push(`  ${dim(`v${s.version}`)}`);
  head.push(`  ${dim(TIPS[s.tipIndex % TIPS.length])}`);
  head.push("");

  // Transcript (wrapped). Reasoning parts are already dropped in the backend.
  // Cursor-style layout: user prompts render as full-bleed filled blocks, and
  // every turn hangs off a single dim thread line (│ … └) that runs from the
  // prompt down to the end of that turn's answer.
  const now = Date.now();
  interface Row { plain: string; thread: string; kind: "content" | "blank" | "block"; seg: number }
  const rows: Row[] = [];
  let seg = -1; // segment id: -1 = before the first prompt (never guttered)
  s.transcript.forEach((item, itemIdx) => {
    if (item.role === "user") {
      // prompt block: pad / text / pad — the thread line starts just below it
      seg++;
      const blank = userBlockRow("", W);
      rows.push({ plain: blank, thread: blank, kind: "block", seg });
      for (const ln of wrapText(item.text, Math.max(20, W - 3))) {
        const row = userBlockRow(" " + ln, W);
        rows.push({ plain: row, thread: row, kind: "block", seg });
      }
      rows.push({ plain: blank, thread: blank, kind: "block", seg });
      rows.push({ plain: "", thread: "", kind: "blank", seg });
      return;
    }
    const isShellTool = item.role === "tool" && /^\s*(?:\u2717\s*)?\$\s/.test(item.text);
    const plainIndent = item.role === "tool" ? (isShellTool ? 1 : 4) : 2;
    const mk = (inner: string, ind: number) => {
      rows.push({ plain: " ".repeat(ind) + inner, thread: " ".repeat(Math.max(0, ind - 2)) + inner, kind: "content", seg });
    };
    const color = (t: string) =>
      item.role === "tool" || item.role === "system" ? dim(t) : item.role === "error" ? `\x1b[31m${t}${ANSI.reset}` : t;
    const wrapW = Math.max(20, W - 6);
    const lines = wrapText(item.text, wrapW);
    lines.forEach((ln, li) => {
      let inner = item.role === "assistant" ? inlineCode(ln) : color(ln);
      // tool elapsed timer: live while the call is open, frozen once it ends
      if (item.role === "tool" && li === 0 && item.startedAt != null) {
        const ms = (item.endedAt ?? (s.streaming ? now : item.startedAt)) - item.startedAt;
        inner += ` ${dim(fmtDur(ms))}`;
      }
      // inverse block at the tip of live-streamed text
      if (item.role === "assistant" && s.streaming && itemIdx === s.liveAssistantIdx && li === lines.length - 1) {
        inner += `\x1b[7m \x1b[27m`;
      }
      mk(inner, plainIndent);
    });
    // collapsible tool output: marker + last two lines, full list on ctrl+o
    if (item.output && item.output.length > 0) {
      const shown = s.outputExpanded ? item.output : item.output.length > 2 ? item.output.slice(-2) : item.output;
      const hidden = item.output.length - shown.length;
      if (hidden > 0) mk(dim(`… ${hidden} output lines hidden · ctrl+o to expand`), 4);
      for (const ol of shown) for (const wl of wrapText(ol, wrapW)) mk(dim(wl), 4);
    }
    rows.push({ plain: "", thread: "", kind: "blank", seg });
  });
  // Thread pass: the last content line of every segment gets └ so the line
  // closes on the answer; trailing blank rows stay un-guttered.
  const lastContent = new Map<number, number>();
  rows.forEach((r, i) => {
    if (r.kind === "content" && stripAnsi(r.plain).trim() !== "") lastContent.set(r.seg, i);
  });
  const wrapped = rows.map((r, i) => {
    if (r.seg < 0 || r.kind === "block") return r.plain;
    const last = lastContent.get(r.seg);
    if (last === undefined || i > last) return r.plain;
    if (r.kind === "blank") return dim("  │");
    return (i === last ? "  └ " : "  │ ") + r.thread;
  });

  // Everything below the transcript (popups, input box, meta, footer).
  const tail: string[] = [];

  // Model picker (cursor-style): header + two-column rows, ↑/↓ navigate.
  if (s.modelOpen) {
    const q = (s.input.startsWith("/model ") ? s.input.slice(7) : "").toLowerCase();
    const matches = s.modelItems
      .filter((m) => !q || m.label.toLowerCase().includes(q) || m.value.toLowerCase().includes(q))
      .slice(0, 8);
    const NAME_W = 34;
    tail.push(dim(`   /model [${q}]  Select model (Tab to edit, Enter to pick)`));
    if (matches.length === 0) tail.push(dim("   (no matching models)"));
    matches.forEach((m, i) => {
      const arrow = i === s.modelIndex ? "→" : " ";
      const name = m.label.padEnd(NAME_W);
      tail.push(i === s.modelIndex
        ? `   ${arrow} ${bold(name)} ${dim(m.value)}`
        : dim(`   ${arrow} ${name} ${m.value}`));
    });
    if (s.modelItems.filter((m) => !q || m.label.toLowerCase().includes(q) || m.value.toLowerCase().includes(q)).length > 8) {
      tail.push(dim("   ↓ more below"));
    }
  }

  if (s.slashOpen && !s.modelOpen) {
    const q = s.slashFilter.toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q || "/")).slice(0, 8);
    const NAME_W = 30;
    if (matches.length === 0) tail.push(dim("   (no matching commands)"));
    matches.forEach((c, i) => {
      const arrow = i === s.slashIndex ? "→" : " ";
      const name = c.name.padEnd(NAME_W);
      tail.push(i === s.slashIndex
        ? `   ${arrow} ${bold(name)} ${dim(c.desc)}`
        : dim(`   ${arrow} ${name} ${c.desc}`));
    });
    if (matches.length >= 8) tail.push(dim("   ↓ more below"));
  }

  if (s.hintsOpen) {
    tail.push("");
    tail.push(dim("  /                  for commands        Ctrl+L          to clear screen"));
    tail.push(dim("  !                  for shell           Ctrl+G          open prompt in $EDITOR"));
    tail.push(dim("  @                  for files           shift + tab     to switch mode"));
    tail.push(dim("  &                  to move to cloud    /run-everything to enable Run Everything"));
    tail.push(dim("  \\ + ⏎ or shift + ⏎ for new line"));
  }

  if (s.cloudMsg) tail.push(dim(`  ${s.cloudMsg}`));

  // Status line — cursor-style: green spinner, bold phase, dim token count
  // (eased by tokenDisplay). Falls back to the completion stamp for ~3s after
  // a turn settles. No "esc to interrupt" here — the box shows ctrl+c instead.
  if (s.streaming) {
    const label = s.phase === "working" ? "Working" : "Running";
    const tok = label === "Running" && s.tokenDisplay > 0 ? dim(`  ${s.tokenDisplay.toLocaleString("en-US")} tokens`) : "";
    tail.push(`  \x1b[32m${SPINNER[s.spinner % SPINNER.length]}\x1b[39m ${bold(label)}${tok}`);
  } else if (s.stamp && now < s.stamp.until) {
    const dur = s.stamp.durMs < 60_000 ? `${(s.stamp.durMs / 1000).toFixed(1)}s` : fmtDur(s.stamp.durMs);
    const tok = s.stamp.tokens > 0 ? dim(` · ${s.stamp.tokens.toLocaleString("en-US")} tokens`) : "";
    const body = `done in ${dur}${tok}`;
    tail.push(`  \x1b[32m✓\x1b[39m ${now - s.stamp.at > 2000 ? dim(body) : body}`);
  }

  // Input box — plain flat grey panel like cursor-agent: no edge rows,
  // just full-width filled lines. While streaming the first row carries a
  // right-aligned "ctrl+c to stop"; the placeholder swaps to "Add a follow-up"
  // once a turn has been submitted.
  const boxTopIdx = tail.length;
  const placeholder = s.followUp ? "Add a follow-up" : "Plan, search, build anything";
  const lines = s.input.split("\n");
  // Locate the terminal cursor inside the (possibly multiline) input.
  let remaining = Math.max(0, Math.min(s.cursor, s.input.length));
  let cursorLine = 0;
  let cursorColInLine = 0;
  lines.forEach((ln, idx) => {
    const prefix = idx === 0 ? "→ " : "  ";
    const isEmpty = ln.length === 0 && idx === 0 && s.input.length === 0;
    // dim via 22m (not 0m) so the surrounding box background survives
    const body = isEmpty ? `\x1b[2m${placeholder}\x1b[22m` : ln;
    const plainLen = 2 + (isEmpty ? placeholder.length : stripAnsi(body).length);
    const padN = Math.max(0, boxW - 1 - plainLen);
    const hint = idx === 0 && s.streaming ? "ctrl+c to stop" : "";
    const roomy = padN > hint.length + 2;
    const pad = roomy ? padN - hint.length - 1 : padN;
    const hintText = roomy ? ` \x1b[2m${hint}\x1b[22m` : "";
    tail.push(" " + boxBg(` ${prefix}${body}${" ".repeat(pad)}${hintText} `));
    if (idx < lines.length - 1 && remaining > ln.length) {
      remaining -= ln.length + 1;
    } else if (remaining !== -1 && remaining <= ln.length) {
      cursorLine = idx;
      cursorColInLine = remaining;
      remaining = -1;
    }
  });
  if (remaining !== -1) { cursorLine = lines.length - 1; cursorColInLine = lines[lines.length - 1]?.length ?? 0; }
  const pct = s.contextPct != null && s.contextPct > 0 ? ` · ${s.contextPct}%` : "";
  const modelLine =
    (s.mode === "agent" ? s.modelLabel : s.mode === "plan" ? `Plan · ${s.modelLabel}` : `Ask · ${s.modelLabel}`) + pct;
  tail.push(`  ${dim(modelLine)}`);
  tail.push(`  ${dim(shortCwd(s.cwd))}`);
  if (s.taskCount > 0) tail.push(dim(`  ${s.taskCount} task${s.taskCount === 1 ? "" : "s"}`));

  // Permission overlay — cursor-agent's menu (divider, context, question, arrow menu).
  if (s.permission) {
    const p = s.permission;
    tail.push(dim("─".repeat(Math.max(10, s.cols - 2))));
    const ctx = p.resources[0] ?? p.action;
    tail.push(` $  ${ctx}`);
    const question = /shell|bash|command|exec/i.test(p.action)
      ? "Run this command?"
      : `${p.action.replace(/[._]/g, " ")}?`;
    tail.push(` ${bold(question)}`);
    if (ctx) {
      const lastTok = ctx.split(/\s+/)[0] ?? ctx;
      tail.push(dim(` Not in allowlist: ${lastTok.slice(0, 40)}`));
    }
    if (p.message) tail.push(dim(` ${p.message.slice(0, s.cols - 4)}`));
    tail.push(`  ${bold("→")} Run (once) ${dim("(y)")}`);
    if (p.hasSave) tail.push(dim(`    Add ${ctx.split(/\s+/)[0] ?? ctx} to allowlist? (tab)`));
    tail.push(dim(`    Run Everything (shift+tab)`));
    tail.push(dim(`    Skip & tell the agent what to do instead (esc or n)`));
    const hint = "ctrl+r to review changed files";
    const pad = Math.max(1, s.cols - hint.length - 2);
    tail.push(dim(" " + " ".repeat(pad) + hint));
  } else if (s.statusMsg) {
    tail.push(`  ${dim(s.statusMsg)}`);
  }

  // Top-anchored flow like cursor-agent: transcript takes what's left.
  const avail = Math.max(5, s.rows - head.length - tail.length - 1);
  const start = Math.max(0, wrapped.length - avail - s.scrollOffset);
  const visible = wrapped.slice(start, start + avail);

  const out = [ANSI.clear, ...head, ...visible, ...tail];
  // Park the real terminal cursor inside the input box (block cursor).
  const cursorRow = head.length + visible.length + boxTopIdx + 1 + cursorLine + 1;
  const cursorCol = cursorColInLine + 5;
  return out.join("\n") + `\x1b[${cursorRow};${cursorCol}H` + ANSI.showCursor;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export type Key =
  | { kind: "char"; ch: string }
  | { kind: "enter"; shift: boolean }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "esc" }
  | { kind: "tab"; shift: boolean }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "ctrl"; key: string }
  | { kind: "unknown" };

export function* splitKeys(data: string): Generator<Key> {
  const chars = Array.from(data);
  let i = 0;
  const rest = () => chars.slice(i).join("");
  while (i < chars.length) {
    const r = rest();
    if (r.startsWith("\x1b[13;2u")) { i += Array.from("\x1b[13;2u").length; yield { kind: "enter", shift: true }; continue; }
    if (r.startsWith("\x1b\r") || r.startsWith("\x1b\n")) { i += 2; yield { kind: "enter", shift: true }; continue; }
    if (r.startsWith("\x1b[3~")) { i += 4; yield { kind: "delete" }; continue; }
    if (r.startsWith("\x1b[Z")) { i += 2; yield { kind: "tab", shift: true }; continue; }
    if (r.startsWith("\x1b[A")) { i += 3; yield { kind: "up" }; continue; }
    if (r.startsWith("\x1b[B")) { i += 3; yield { kind: "down" }; continue; }
    if (r.startsWith("\x1b[C")) { i += 3; yield { kind: "right" }; continue; }
    if (r.startsWith("\x1b[D")) { i += 3; yield { kind: "left" }; continue; }
    const ch = chars[i];
    if (ch === "\r" || ch === "\n") { i++; yield { kind: "enter", shift: false }; continue; }
    if (ch === "\t") { i++; yield { kind: "tab", shift: false }; continue; }
    if (ch === "\x7f" || ch === "\b") { i++; yield { kind: "backspace" }; continue; }
    if (ch === "\x1b") {
      // lone ESC (or alt+char handled as ESC + char pair)
      if (i + 1 < chars.length && chars[i + 1] !== "\x1b") {
        // alt+char -> skip ESC, emit char next iteration
        i++;
        continue;
      }
      i++;
      yield { kind: "esc" };
      continue;
    }
    if (ch === "\x03") { i++; yield { kind: "ctrl", key: "c" }; continue; }
    if (ch === "\x0c") { i++; yield { kind: "ctrl", key: "l" }; continue; }
    if (ch === "\x07") { i++; yield { kind: "ctrl", key: "g" }; continue; }
    if (ch === "\x01") { i++; yield { kind: "ctrl", key: "a" }; continue; }
    if (ch === "\x05") { i++; yield { kind: "ctrl", key: "e" }; continue; }
    if (ch === "\x15") { i++; yield { kind: "ctrl", key: "u" }; continue; }
    if (ch === "\x0b") { i++; yield { kind: "ctrl", key: "k" }; continue; }
    if (ch === "\x04") { i++; yield { kind: "ctrl", key: "d" }; continue; }
    if (ch === "\x12") { i++; yield { kind: "ctrl", key: "r" }; continue; }
    if (ch === "\x0f") { i++; yield { kind: "ctrl", key: "o" }; continue; }
    i++;
    yield { kind: "char", ch };
  }
}

export function parseKey(data: Buffer): Key {
  const s = data.toString("utf8");
  if (s === "\r" || s === "\n") return { kind: "enter", shift: false };
  if (s === "\x1b\r" || s === "\x1b\n") return { kind: "enter", shift: true };
  if (s === "\x1b[13;2u") return { kind: "enter", shift: true }; // kitty shift-enter
  if (s === "\x03") return { kind: "ctrl", key: "c" };
  if (s === "\x0c") return { kind: "ctrl", key: "l" };
  if (s === "\x07") return { kind: "ctrl", key: "g" };
  if (s === "\x01") return { kind: "ctrl", key: "a" };
  if (s === "\x05") return { kind: "ctrl", key: "e" };
  if (s === "\x15") return { kind: "ctrl", key: "u" };
  if (s === "\x0b") return { kind: "ctrl", key: "k" };
  if (s === "\x0f") return { kind: "ctrl", key: "o" };
  if (s === "\x04") return { kind: "ctrl", key: "d" };
  if (s === "\x1b") return { kind: "esc" };
  if (s === "\x7f" || s === "\x08") return { kind: "backspace" };
  if (s === "\x1b[3~") return { kind: "delete" };
  if (s === "\x09") return { kind: "tab", shift: false };
  if (s === "\x1b[Z") return { kind: "tab", shift: true };
  if (s === "\x1b[A") return { kind: "up" };
  if (s === "\x1b[B") return { kind: "down" };
  if (s === "\x1b[C") return { kind: "right" };
  if (s === "\x1b[D") return { kind: "left" };
  if (s.length === 1) return { kind: "char", ch: s };
  // alt+char (esc prefix) -> treat as char
  if (s.startsWith("\x1b") && s.length === 2) return { kind: "char", ch: s[1] };
  return { kind: "unknown" };
}
