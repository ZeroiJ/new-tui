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
  };
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

  // Transcript (wrapped). Reasoning parts are already dropped in the backend;
  // user lines get ●, tool lines get ⏺.
  const wrapped: string[] = [];
  for (const item of s.transcript) {
    // cursor-style roles: user gets ●, tool lines are indented 4 (shell cmds keep $)
    const isShellTool = item.role === "tool" && /^\s*\$\s/.test(item.text);
    const prefix = item.role === "user" ? "  ● " : item.role === "tool" ? (isShellTool ? " " : "    ") : item.role === "system" ? "  " : "  ";
    const color = (t: string) =>
      item.role === "user" ? bold(t) : item.role === "tool" || item.role === "system" ? dim(t) : item.role === "error" ? `\x1b[31m${t}${ANSI.reset}` : t;
    for (const ln of wrapText(item.text, Math.max(20, W - 6))) {
      wrapped.push(color(prefix + ln));
    }
    wrapped.push("");
  }

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

  // Status line — cursor-style spinner + phase + live token count (above box).
  if (s.streaming) {
    const label =
      s.phase === "working"
        ? "Working"
        : `Running${s.turnTokens > 0 ? `  ${s.turnTokens.toLocaleString("en-US")} tokens` : ""}`;
    tail.push(dim(`  ${SPINNER[s.spinner % SPINNER.length]} ${label} — esc to interrupt`));
  }

  // Input box — plain flat grey panel like cursor-agent: no edge rows,
  // just full-width filled lines.
  const boxTopIdx = tail.length;
  const placeholder = "Plan, search, build anything";
  const lines = s.input.split("\n");
  // Locate the terminal cursor inside the (possibly multiline) input.
  let remaining = Math.max(0, Math.min(s.cursor, s.input.length));
  let cursorLine = 0;
  let cursorColInLine = 0;
  lines.forEach((ln, idx) => {
    const prefix = idx === 0 ? "→ " : "  ";
    const isEmpty = ln.length === 0 && idx === 0 && s.input.length === 0;
    const body = isEmpty ? dim(placeholder) : ln;
    const plainLen = 2 + (isEmpty ? placeholder.length : stripAnsi(body).length);
    const padN = Math.max(0, boxW - 1 - plainLen);
    tail.push(" " + boxBg(` ${prefix}${body}${" ".repeat(padN)} `));
    if (idx < lines.length - 1 && remaining > ln.length) {
      remaining -= ln.length + 1;
    } else if (remaining !== -1 && remaining <= ln.length) {
      cursorLine = idx;
      cursorColInLine = remaining;
      remaining = -1;
    }
  });
  if (remaining !== -1) { cursorLine = lines.length - 1; cursorColInLine = lines[lines.length - 1]?.length ?? 0; }
  const modelLine =
    s.mode === "agent" ? s.modelLabel : s.mode === "plan" ? `Plan · ${s.modelLabel}` : `Ask · ${s.modelLabel}`;
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
