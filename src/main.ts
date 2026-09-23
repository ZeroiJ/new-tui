#!/usr/bin/env bun
import { ANSI, commandList, createState, render, splitKeys, type Key, type UIState } from "./ui";
import { SPINNERS } from "./spinners";
import * as BE from "./backend";

const TUI_VERSION = "0.2.0";

interface Args {
  prompt: string;
  mode: "agent" | "plan" | "ask" | null;
  resume: string | null;
  cont: boolean;
  model: string | null;
  workspace: string;
  print: boolean;
  trust: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { prompt: "", mode: null, resume: null, cont: false, model: null, workspace: process.cwd(), print: false, trust: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "-p" || t === "--print") a.print = true;
    else if (t === "--mode" && argv[i + 1]) { const m = argv[++i]; if (m === "plan" || m === "ask") a.mode = m; }
    else if (t === "--plan") a.mode = "plan";
    else if ((t === "--resume" || t === "--continue") && !argv[i + 1]?.startsWith("-")) { a.resume = argv[++i] ?? ""; a.cont = true; }
    else if (t === "--continue" || t === "-c") a.cont = true;
    else if (t === "--model" && argv[i + 1]) a.model = argv[++i];
    else if ((t === "--workspace" || t === "--add-dir") && argv[i + 1]) a.workspace = argv[++i];
    else if (t === "--trust" || t === "-f" || t === "--yolo" || t === "--force") a.trust = true;
    else if (!t.startsWith("-")) rest.push(t);
  }
  a.prompt = rest.join(" ");
  return a;
}

async function runPrintMode(args: Args) {
  const client = await BE.getClient();
  void client;
  const sessions = await BE.listSessions();
  let sid: string | undefined;
  if (args.cont && sessions.length > 0) sid = String((sessions[0] as Record<string, unknown>)["id"]);
  if (args.resume) sid = args.resume;
  if (!sid) {
    const s = await BE.createSession(args.workspace, undefined, args.model ?? undefined);
    sid = String(s["id"]);
  }
  let text = args.prompt || "Hello";
  if (args.mode === "plan") text = `[PLAN MODE - propose a plan, no edits]\n${text}`;
  if (args.mode === "ask") text = `[ASK MODE - read-only Q&A]\n${text}`;
  // fire + poll for result (no TUI)
  await BE.sendPrompt(sid, text, args.model ? { model: args.model } : undefined);
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const msgs = await BE.listMessages(sid);
    const last = [...msgs].reverse().find((m) => m.role.includes("assistant") && m.text.trim());
    if (last) {
      process.stdout.write(last.text + "\n");
      return;
    }
  }
  process.stdout.write("(no response yet — resume with --continue)\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.print) {
    await runPrintMode(args);
    process.exit(0);
  }

  const cwd = args.workspace;
  const s: UIState = createState(cwd, "…"); // version filled from server info below
  if (args.mode) s.mode = args.mode;
  if (args.model) s.modelLabel = args.model;

  // Buffer keystrokes typed during async bootstrap so nothing is lost.
  const early: string[] = [];
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const earlyListener = (b: string) => { early.push(b); };
  process.stdin.on("data", earlyListener);

  // opencode session bootstrap
  let sessionID = "";
  try {
    s.statusMsg = "connecting to opencode service…";
    draw(s);
    await BE.getClient();
    const info = await BE.getServerInfo();
    s.version = info?.version ?? "unknown";
    const sessions = await BE.listSessions();
    if (args.resume) sessionID = args.resume;
    else if (args.cont && sessions.length > 0) sessionID = String((sessions[0] as Record<string, unknown>)["id"]);
    if (!sessionID) {
      const created = await BE.createSession(cwd, "Cursor-look session");
      sessionID = String(created["id"]);
    }
    // load history
    try {
      const msgs = await BE.listMessages(sessionID);
      for (const m of msgs.slice(-30)) {
        s.transcript.push({ role: m.role.startsWith("user") ? "user" : m.role.includes("tool") ? "tool" : "assistant", text: m.text });
      }
      if (msgs.length > 0) s.followUp = true;
    } catch { /* ignore */ }
    // resolve real model label for this session (friendly name) + context window
    try {
      const sess = await BE.getSession(sessionID);
      const mref = sess["model"] as { providerID: string; id: string } | undefined;
      s.modelLabel = mref ? await BE.friendlyModelName(mref) : await BE.getDefaultModelName();
      s.contextLimit = await BE.modelContextLimit(mref ?? null);
    } catch { /* keep default */ }
    void refreshContextPct(s, sessionID);
    // preload model picker items
    try {
      const models = await BE.listModels();
      s.modelItems = models.map((m) => {
        const id = String(m["id"] ?? "");
        const provider = String(m["providerID"] ?? m["provider"] ?? "");
        return { label: String(m["name"] ?? id), value: `${provider}/${id}` };
      }).filter((m) => m.value !== "/");
    } catch { /* picker shows empty */ }
    // pending task count (shown under the box when > 0)
    try {
      s.taskCount = (await BE.inboxList(sessionID)).length;
    } catch { /* leave 0 */ }
    // opencode's own slash commands (built-in + project markdown commands)
    s.ocCommands = (await BE.listCommands(cwd)).map((c) => ({ name: "/" + c.name, desc: c.description ?? "" }));
    s.statusMsg = "";
  } catch (e) {
    s.statusMsg = "";
    s.transcript.push({ role: "error", text: `Failed to connect to opencode service: ${String(e)}. Is 'opencode2 service status' healthy?` });
  }

  if (args.prompt) {
    void submit(s, sessionID, args.prompt);
  }

  // ----- TUI loop (render() parks + shows the terminal cursor itself) -----
  process.stdout.write(ANSI.altOn);
  const cleanup = () => {
    process.stdout.write(ANSI.showCursor + ANSI.altOff);
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  const redraw = () => draw(s);
  requestRedraw = redraw;

  // spinner tick — also drives the token tick-up, stamp expiry, and tool timers
  const tick = setInterval(() => {
    // thinking animation runs off a wall clock so each design keeps its own
    // cycle time regardless of redraw jitter
    if (s.streaming && s.spinStart == null) s.spinStart = Date.now();
    if (!s.streaming) s.spinStart = null;
    let need = s.streaming || !!s.statusMsg || s.stamp != null;
    if (s.stamp && Date.now() >= s.stamp.until) { s.stamp = null; need = true; }
    if (s.tokenDisplay !== s.turnTokens) {
      const d = s.turnTokens - s.tokenDisplay;
      s.tokenDisplay = Math.abs(d) <= 3 ? s.turnTokens : s.tokenDisplay + Math.sign(d) * Math.max(1, Math.ceil(Math.abs(d) / 3));
      need = true;
    }
    if (need) redraw();
  }, 120);

  // tip rotation
  const tipTimer = setInterval(() => { s.tipIndex++; redraw(); }, 15000);

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let history: string[] = [];
  let histIdx = -1;
  let ctrlCCount = 0;
  let attachedFiles: string[] = [];
  let autoApprove = false;

  function updateSlash() {
    if (s.input.startsWith("/model") && (s.input === "/model" || s.input.startsWith("/model "))) {
      // model picker takes over — suppress the slash popup
      s.slashOpen = false;
      s.modelOpen = true;
      s.modelIndex = 0;
      return;
    }
    s.modelOpen = false;
    if (s.input.startsWith("/")) {
      s.slashOpen = true;
      const space = s.input.indexOf(" ");
      s.slashFilter = (space === -1 ? s.input : s.input.slice(0, space)).trim() || "/";
      const matches = commandList(s).filter((c) => c.name.startsWith(s.slashFilter || "/"));
      s.slashIndex = Math.min(s.slashIndex, Math.max(0, matches.length - 1));
    } else s.slashOpen = false;
  }

  async function handleKey(key: Key) {
    ctrlCCount = key.kind === "ctrl" && key.key === "c" ? ctrlCCount + 1 : 0;

    // diff overlay: ↑/↓ scroll (pg-up/down too), esc/ctrl+r closes
    if (s.diffOpen) {
      const room = Math.max(3, s.rows - 4);
      if (key.kind === "up") { s.diffScroll = Math.max(0, s.diffScroll - 1); redraw(); return; }
      if (key.kind === "down") { s.diffScroll = Math.min(Math.max(0, s.diffLines.length - room), s.diffScroll + 1); redraw(); return; }
      if (key.kind === "esc" || (key.kind === "ctrl" && key.key === "r")) { s.diffOpen = false; redraw(); return; }
      if (key.kind === "enter") { s.diffScroll = Math.min(Math.max(0, s.diffLines.length - room), s.diffScroll + room); redraw(); return; }
      return; // swallow other keys while reviewing
    }

    // permission overlay: cursor menu keys — y once, tab allowlist, shift+tab run-everything, esc/n reject
    if (s.permission) {
      if (key.kind === "char" && (key.ch === "y" || key.ch === "a")) {
        const p = s.permission; s.permission = null; s.statusMsg = "allowed once";
        try { await BE.replyPermission(sessionID, p.id, "once"); } catch (e) { s.statusMsg = String(e); }
        redraw(); return;
      }
      if (key.kind === "tab" && !key.shift) {
        const p = s.permission; s.permission = null; s.statusMsg = "added to allowlist";
        try { await BE.replyPermission(sessionID, p.id, "always"); } catch (e) { s.statusMsg = String(e); }
        redraw(); return;
      }
      if (key.kind === "tab" && key.shift) {
        const p = s.permission; s.permission = null; autoApprove = true; s.statusMsg = "Run Everything enabled";
        try { await BE.replyPermission(sessionID, p.id, "always"); } catch (e) { s.statusMsg = String(e); }
        redraw(); return;
      }
      if (key.kind === "char" && (key.ch === "d" || key.ch === "n")) {
        const p = s.permission; s.permission = null; s.statusMsg = "rejected";
        try { await BE.replyPermission(sessionID, p.id, "reject"); } catch (e) { s.statusMsg = String(e); }
        redraw(); return;
      }
      if (key.kind === "esc") {
        const p = s.permission; s.permission = null; s.statusMsg = "skipped — agent informed";
        try { await BE.replyPermission(sessionID, p.id, "reject"); } catch { /* */ }
        redraw(); return;
      }
    }

    // model picker navigation — runs before slash/history keys
    if (s.modelOpen) {
      const q = (s.input.startsWith("/model ") ? s.input.slice(7) : "").toLowerCase();
      const matches = s.modelItems
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => !q || m.label.toLowerCase().includes(q) || m.value.toLowerCase().includes(q));
      const pick = async () => {
        const hit = matches[Math.min(s.modelIndex, matches.length - 1)]?.m;
        if (!hit) return;
        const [providerID, ...rest] = hit.value.split("/");
        try {
          await BE.switchModel(sessionID, { providerID, id: rest.join("/") });
          s.modelLabel = hit.label;
          s.statusMsg = `Model → ${hit.label}`;
          s.transcript.push({ role: "system", text: `Model → ${hit.label}` });
          s.contextLimit = await BE.modelContextLimit({ providerID, id: rest.join("/") });
          void refreshContextPct(s, sessionID);
        } catch (e) {
          s.transcript.push({ role: "error", text: `switchModel failed: ${String(e)}` });
        }
        s.modelOpen = false;
        s.input = ""; s.cursor = 0; s.slashOpen = false;
      };
      if (key.kind === "up") { s.modelIndex = Math.max(0, s.modelIndex - 1); redraw(); return; }
      if (key.kind === "down") { s.modelIndex = Math.min(Math.max(0, matches.length - 1), s.modelIndex + 1); redraw(); return; }
      if (key.kind === "enter" && !key.shift) { await pick(); redraw(); return; }
      if (key.kind === "tab" && !key.shift) {
        const hit = matches[Math.min(s.modelIndex, matches.length - 1)]?.m;
        if (hit) { s.input = `/model ${hit.value}`; s.cursor = s.input.length; }
        redraw(); return;
      }
      if (key.kind === "esc") { s.modelOpen = false; s.input = ""; s.cursor = 0; redraw(); return; }
      if (key.kind === "backspace" || key.kind === "delete" || key.kind === "char" ||
          key.kind === "left" || key.kind === "right" || key.kind === "ctrl") {
        // fall through to normal editing (filter updates via updateSlash)
      } else return;
    }

    if (key.kind === "ctrl") {
      if (key.key === "c") {
        if (s.streaming) { try { await BE.interruptSession(sessionID); } catch { /* */ } s.streaming = false; freezeToolTimers(s); s.statusMsg = "interrupted"; redraw(); return; }
        if (ctrlCCount >= 2 || s.input.length === 0) { clearInterval(tick); clearInterval(tipTimer); cleanup(); process.exit(0); }
        s.statusMsg = "press Ctrl+C again to quit";
        redraw(); return;
      }
      if (key.key === "l") { s.transcript = []; s.statusMsg = "screen cleared"; redraw(); return; }
      if (key.key === "o") { s.outputExpanded = !s.outputExpanded; redraw(); return; } // expand/collapse tool output
      if (key.key === "g") { await openEditor(s); redraw(); return; }
      if (key.key === "r") {
        // ctrl+r — review changed files (vcs.diff overlay)
        try {
          const diffs = await BE.vcsDiff(s.cwd);
          const lines: string[] = [];
          for (const d of diffs) {
            lines.push(`${d.file}  (${d.status} +${d.additions} -${d.deletions})`);
            for (const pl of d.patch.split("\n")) lines.push(pl);
            lines.push("");
          }
          s.diffLines = lines;
          s.diffScroll = 0;
          s.diffOpen = true;
        } catch (e) {
          s.statusMsg = `diff failed: ${String(e)}`;
        }
        redraw(); return;
      }
      if (key.key === "u") { s.input = ""; s.cursor = 0; updateSlash(); redraw(); return; }
      if (key.key === "d" && s.input.length === 0) { clearInterval(tick); clearInterval(tipTimer); cleanup(); process.exit(0); }
      redraw(); return;
    }
    if (key.kind === "esc") {
      if (s.slashOpen) { s.slashOpen = false; redraw(); return; }
      if (s.hintsOpen) { s.hintsOpen = false; redraw(); return; }
      if (s.streaming) { try { await BE.interruptSession(sessionID); } catch { /* */ } s.streaming = false; freezeToolTimers(s); s.statusMsg = "interrupted (esc)"; redraw(); return; }
      return;
    }
    if (key.kind === "tab") {
      if (key.shift) {
        s.mode = s.mode === "agent" ? "plan" : s.mode === "plan" ? "ask" : "agent";
        s.statusMsg = `mode: ${s.mode}`;
        redraw(); return;
      }
      // Tab: complete slash
      if (s.slashOpen) {
        const matches = commandList(s).filter((c) => c.name.startsWith(s.slashFilter || "/"));
        const m = matches[s.slashIndex];
        if (m) { s.input = m.name + " "; s.cursor = s.input.length; updateSlash(); redraw(); }
        return;
      }
      return;
    }
    if (key.kind === "up") {
      if (s.slashOpen) { s.slashIndex = Math.max(0, s.slashIndex - 1); redraw(); return; }
      if (history.length && (histIdx < history.length - 1)) { histIdx++; s.input = history[history.length - 1 - histIdx] ?? ""; s.cursor = s.input.length; updateSlash(); redraw(); }
      return;
    }
    if (key.kind === "down") {
      if (s.slashOpen) {
        const matches = commandList(s).filter((c) => c.name.startsWith(s.slashFilter || "/"));
        s.slashIndex = Math.min(matches.length - 1, s.slashIndex + 1); redraw(); return;
      }
      if (histIdx > 0) { histIdx--; s.input = history[history.length - 1 - histIdx] ?? ""; }
      else { histIdx = -1; s.input = ""; }
      s.cursor = s.input.length; updateSlash(); redraw(); return;
    }
    if (key.kind === "left") { s.cursor = Math.max(0, s.cursor - 1); redraw(); return; }
    if (key.kind === "right") { s.cursor = Math.min(s.input.length, s.cursor + 1); redraw(); return; }
    if (key.kind === "backspace") { if (s.cursor > 0) { s.input = s.input.slice(0, s.cursor - 1) + s.input.slice(s.cursor); s.cursor--; } updateSlash(); redraw(); return; }
    if (key.kind === "delete") { s.input = s.input.slice(0, s.cursor) + s.input.slice(s.cursor + 1); updateSlash(); redraw(); return; }
    if (key.kind === "enter") {
      if (key.shift) { s.input = s.input.slice(0, s.cursor) + "\n" + s.input.slice(s.cursor); s.cursor++; redraw(); return; }
      // slash autocomplete enter picks highlighted
      if (s.slashOpen && !s.input.includes(" ")) {
        const matches = commandList(s).filter((c) => c.name.startsWith(s.slashFilter || "/"));
        const m = matches[s.slashIndex];
        if (m && s.input !== m.name + " ") { s.input = m.name + " "; s.cursor = s.input.length; updateSlash(); redraw(); return; }
      }
      const text = s.input;
      if (!text.trim()) { redraw(); return; }
      s.input = ""; s.cursor = 0; s.slashOpen = false; histIdx = -1;
      history.push(text);
      if (text.trim() === "?") { s.hintsOpen = !s.hintsOpen; redraw(); return; }
      const newId = await handleLine(s, sessionID, text, { attachedFiles, autoApprove, setAuto: (v: boolean) => { autoApprove = v; } });
      if (newId) sessionID = newId;
      attachedFiles = [];
      redraw();
      return;
    }
    if (key.kind === "char") {
      // trailing backslash + enter newline hint: if user typed "\" then enter handled above as submit; support "\\"+enter via shift-enter only.
      s.input = s.input.slice(0, s.cursor) + key.ch + s.input.slice(s.cursor);
      s.cursor += key.ch.length;
      updateSlash();
      // live hints: typing ? alone
      redraw();
      return;
    }
  }

  async function onData(buf: string) {
    for (const key of splitKeys(buf)) await handleKey(key);
  }

  process.stdin.on("data", onData);
  process.stdin.removeListener("data", earlyListener);
  for (const b of early.splice(0)) void onData(b);

  process.stdout.on("resize", () => {
    s.cols = process.stdout.columns ?? 120;
    s.rows = process.stdout.rows ?? 36;
    redraw();
  });

  function draw(st: UIState) { process.stdout.write(render(st)); }
  draw(s);

  // background event pump (streaming deltas, permissions, tool progress)
  void eventPump(s, () => sessionID, () => autoApprove, redraw);
}

async function openEditor(s: UIState) {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  const tmp = `/tmp/cursor-opencode-${Date.now()}.md`;
  await Bun.write(tmp, s.input);
  process.stdout.write(ANSI.showCursor + ANSI.altOff);
  try {
    const proc = Bun.spawn([editor, tmp], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    await proc.exited;
    const content = await Bun.file(tmp).text().catch(() => "");
    s.input = content;
    s.cursor = s.input.length;
  } finally {
    process.stdout.write(ANSI.altOn);
  }
}

async function handleLine(
  s: UIState,
  sessionID: string,
  text: string,
  ctx: { attachedFiles: string[]; autoApprove: boolean; setAuto: (v: boolean) => void },
): Promise<string | null> {
  const t = text.trim();
  // ! shell
  if (t.startsWith("!")) {
    const cmd = t.slice(1).trim() || "ls";
    s.transcript.push({ role: "user", text: `!${cmd}` });
    const t0 = Date.now();
    try {
      const proc = Bun.spawn(["bash", "-c", cmd], { cwd: s.cwd, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      s.transcript.push({ role: "tool", text: `$ ${cmd}\n${(out + err).slice(0, 4000) || "(no output)"}`, startedAt: t0, endedAt: Date.now() });
    } catch (e) {
      s.transcript.push({ role: "error", text: String(e) });
    }
    return null;
  }
  // @ files
  if (t.startsWith("@")) {
    const files = t.slice(1).trim().split(/\s+/).filter(Boolean);
    for (const f of files) {
      try {
        const content = await Bun.file(`${s.cwd}/${f}`).text().catch(() => null) ?? await Bun.file(f).text().catch(() => null);
        if (content) s.transcript.push({ role: "tool", text: `@${f} attached (${content.length} chars)` });
        else s.transcript.push({ role: "error", text: `@${f}: not found` });
      } catch (e) { s.transcript.push({ role: "error", text: String(e) }); }
    }
    if (files.length) {
      // send as context on next prompt: stash by pushing a system note and prompting opencode with file paths
      await submit(s, sessionID, `Attached files: ${files.join(", ")}. ${t.includes(" ") ? t.slice(t.indexOf(" ") + 1) : "Review them."}`, { files });
    }
    return null;
  }
  // & cloud
  if (t.startsWith("&")) {
    const task = t.slice(1).trim();
    s.transcript.push({ role: "user", text: `& ${task}` });
    s.transcript.push({ role: "assistant", text: `Cloud handoff is not wired to cursor.com in this clone — continuing locally (opencode session).\nTrack cloud tasks at https://cursor.com/agents` });
    if (task) await submit(s, sessionID, task);
    return null;
  }
  // / commands
  if (t.startsWith("/")) {
    return await handleSlash(s, sessionID, t, ctx);
  }
  await submit(s, sessionID, text);
  return null;
}

async function handleSlash(s: UIState, sessionID: string, t: string, ctx: { autoApprove: boolean; setAuto: (v: boolean) => void }): Promise<string | null> {
  const [cmd, ...rest] = t.split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/quit":
    case "/exit":
      process.exit(0);
    case "/clear":
      s.transcript = [];
      return null;
    case "/help": {
      const all = commandList(s);
      const oc = all.filter((c) => c.source === "opencode");
      const local = all.filter((c) => c.source !== "opencode");
      const body = [
        ...(oc.length ? ["opencode commands:", ...oc.map((c) => `${c.name} — ${c.desc}`), ""] : []),
        ...(local.length ? ["this TUI:", ...local.map((c) => `${c.name} — ${c.desc}`)] : []),
      ].join("\n");
      s.transcript.push({ role: "assistant", text: `${body}\n\nKeys: esc interrupt • Ctrl+L clear • Ctrl+G editor • Ctrl+O expand output • Shift+Tab mode • \\+Enter newline` });
      return null;
    }
    case "/new": {
      const created = await BE.createSession(s.cwd, arg || "Cursor-look session");
      const id = String(created["id"]);
      s.transcript.push({ role: "system", text: `New opencode session ${id}` });
      return id;
    }
    case "/ls": {
      const list = await BE.listSessions();
      const lines = list.slice(0, 15).map((x) => {
        const r = x as Record<string, unknown>;
        return `${String(r["id"])}  ${String((r["title"] as string) ?? "(untitled)")}`;
      });
      s.transcript.push({ role: "assistant", text: lines.join("\n") || "(no sessions)" });
      return null;
    }
    case "/resume": {
      if (!arg) { s.transcript.push({ role: "error", text: "Usage: /resume <session-id>" }); return null; }
      try {
        const msgs = await BE.listMessages(arg);
        s.transcript = msgs.slice(-30).map((m) => ({ role: m.role.startsWith("user") ? "user" as const : "assistant" as const, text: m.text }));
        s.transcript.push({ role: "system", text: `Resumed ${arg}` });
        s.followUp = true;
        s.contextLimit = await BE.modelContextLimit(null);
        void refreshContextPct(s, arg);
        return arg;
      } catch (e) { s.transcript.push({ role: "error", text: String(e) }); return null; }
    }
    case "/compact":
      await BE.compactSession(sessionID);
      s.transcript.push({ role: "system", text: "Session compacted." });
      return null;
    case "/fork": {
      const f = await BE.forkSession(sessionID);
      const id = String(f["id"]);
      s.transcript.push({ role: "system", text: `Forked → ${id}` });
      return id;
    }
    case "/plan":
      s.mode = "plan";
      if (arg) await submit(s, sessionID, `[PLAN MODE - design approach, ask clarifying questions, no edits]\n${arg}`);
      else s.transcript.push({ role: "system", text: "Plan mode on (Shift+Tab to switch back)." });
      return null;
    case "/ask":
      s.mode = "ask";
      if (arg) await submit(s, sessionID, `[ASK MODE - read-only Q&A, no edits or command execution]\n${arg}`);
      else s.transcript.push({ role: "system", text: "Ask mode on (read-only)." });
      return null;
    case "/model": {
      const models = await BE.listModels();
      if (!arg) {
        const names = models
          .map((m) => `${String(m["name"] ?? m["id"])}  (${String(m["providerID"] ?? m["provider"] ?? "")}/${String(m["id"])})`)
          .slice(0, 20);
        s.transcript.push({ role: "assistant", text: `Models (opencode):\n${names.join("\n") || "(none listed)"}\n\nUse /model <provider/model> to switch.` });
      } else {
        // resolve friendly name + switch the session's model server-side
        const hit = models.find(
          (m) =>
            String(m["id"]) === arg ||
            `${String(m["providerID"] ?? m["provider"])}/${String(m["id"])}` === arg ||
            String(m["name"] ?? "").toLowerCase() === arg.toLowerCase(),
        );
        const providerID = String(hit?.["providerID"] ?? hit?.["provider"] ?? (arg.includes("/") ? arg.split("/")[0] : "opencode"));
        const id = String(hit?.["id"] ?? (arg.includes("/") ? arg.split("/").slice(1).join("/") : arg));
        const friendly = String(hit?.["name"] ?? id);
        try {
          await BE.switchModel(sessionID, { providerID, id });
          s.modelLabel = friendly;
          s.transcript.push({ role: "system", text: `Model → ${friendly}` });
          s.contextLimit = await BE.modelContextLimit({ providerID, id });
          void refreshContextPct(s, sessionID);
        } catch (e) {
          s.transcript.push({ role: "error", text: `switchModel failed: ${String(e)}` });
        }
      }
      return null;
    }
    case "/agent": {
      const agents = await BE.listAgents();
      if (!arg) {
        const names = agents.slice(0, 20).map((m) => String((m as Record<string, unknown>)["name"] ?? (m as Record<string, unknown>)["id"] ?? JSON.stringify(m))).join("\n");
        s.transcript.push({ role: "assistant", text: `Agents:\n${names || "(none listed)"}` });
      } else {
        s.transcript.push({ role: "system", text: `Agent → ${arg} (applies to next prompt)` });
        (s as unknown as Record<string, unknown>)["pendingAgent"] = arg;
      }
      return null;
    }
    case "/mcp":
    case "/sandbox":
    case "/auto-review":
    case "/run-everything": {
      if (cmd === "/run-everything") {
        ctx.setAuto(!ctx.autoApprove);
        s.transcript.push({ role: "system", text: `Run Everything ${ctx.autoApprove ? "enabled (auto-approve)" : "disabled"}` });
      } else {
        s.transcript.push({ role: "assistant", text: `${cmd}: backed by opencode permissions. Use /run-everything to toggle auto-approve (currently ${ctx.autoApprove ? "on" : "off"}).` });
      }
      return null;
    }
    case "/add-dir":
      if (arg) { s.cwd = arg; s.transcript.push({ role: "system", text: `Workspace → ${arg}` }); }
      else s.transcript.push({ role: "error", text: "Usage: /add-dir <path>" });
      return null;
    case "/goal":
      s.transcript.push({ role: "system", text: `Durable goal started: ${arg || "(no objective)"} — continuing while idle (local emulation).` });
      if (arg) await submit(s, sessionID, `[GOAL - continue until done, working autonomously]\n${arg}`);
      return null;
    case "/spinner": {
      if (!arg) {
        const list = SPINNERS.map((x) => `${x.name.padEnd(15)} ${x.label}  ${x.cycleMs}ms`).join("\n");
        s.transcript.push({ role: "assistant", text: `Thinking animations (loading.dev):\n${list}\n\nUse /spinner <name>. Current: ${s.spinnerName}` });
        return null;
      }
      const hit = SPINNERS.find((x) => x.name === arg);
      if (!hit) {
        s.transcript.push({ role: "error", text: `Unknown spinner "${arg}". Try: ${SPINNERS.map((x) => x.name).join(", ")}` });
        return null;
      }
      s.spinnerName = hit.name;
      s.spinStart = s.streaming ? Date.now() : null;
      s.transcript.push({ role: "system", text: `Spinner → ${hit.name} (${hit.label})` });
      return null;
    }
    case "/diff": {
      try {
        const proc = Bun.spawn(["git", "diff", "--stat"], { cwd: s.cwd, stdout: "pipe", stderr: "pipe" });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        s.transcript.push({ role: "tool", text: out.trim() || "(clean tree)" });
      } catch (e) { s.transcript.push({ role: "error", text: String(e) }); }
      return null;
    }
    default: {
      // Anything opencode itself provides runs server-side through the normal
      // prompt pipeline, so it streams, renders and stamps like a turn.
      const bare = cmd.replace(/^\//, "");
      const oc = s.ocCommands.find((c) => c.name.replace(/^\//, "") === bare);
      if (oc) {
        await submit(s, sessionID, `${"/" + bare}${arg ? " " + arg : ""}`, {
          run: () => BE.runCommand(sessionID, bare, arg),
        });
        return null;
      }
      s.transcript.push({ role: "error", text: `Unknown command ${cmd}. Try /help.` });
      return null;
    }
  }
}

let submitSeq = 0;
let requestRedraw: () => void = () => {};

/** Freeze any tool timer still counting (turn end / interrupt). */
function freezeToolTimers(s: UIState) {
  const now = Date.now();
  for (const it of s.transcript) {
    if (it.role === "tool" && it.startedAt != null && it.endedAt == null) it.endedAt = now;
  }
}

/** Refresh the `· 7.5%` context readout from the newest assistant message. */
async function refreshContextPct(s: UIState, sessionID: string) {
  try {
    if (!s.contextLimit || !sessionID) return;
    const u = await BE.lastAssistantUsage(sessionID);
    if (!u) { s.contextPct = null; return; }
    const pct = Math.round(((u.input + u.cacheRead) / s.contextLimit) * 1000) / 10;
    s.contextPct = pct > 0 ? Math.min(100, pct) : null;
  } catch { /* keep previous */ }
  requestRedraw();
}

async function submit(s: UIState, sessionID: string, text: string, opts?: { files?: string[]; run?: (body: string) => Promise<unknown> }) {
  const mySeq = ++submitSeq;
  const t0 = Date.now();
  s.transcript.push({ role: "user", text });
  s.streaming = true;
  s.phase = "working";
  s.turnTokens = 0;
  s.tokenDisplay = 0;
  s.stamp = null; // previous completion stamp yields to the new turn
  s.followUp = true; // box placeholder becomes "Add a follow-up"
  // usage.updated is session-cumulative — snapshot output tokens as baseline
  try {
    const sess = (await BE.getSession(sessionID)) as unknown as { tokens?: { output?: number } };
    s.turnBaseline = Number(sess?.tokens?.output ?? 0);
  } catch { s.turnBaseline = 0; }
  s.liveAssistantId = null;
  s.liveAssistantIdx = null;
  s.seenOrdinals.clear();
  s.toolLineById.clear();
  s.statusMsg = ""; // phase is shown by the status line above the box
  const turnStart = s.transcript.length; // first index owned by this turn
  let assistantIdx = -1;
  const ensureAssistant = () => {
    if (assistantIdx === -1) {
      s.transcript.push({ role: "assistant", text: "" });
      assistantIdx = s.transcript.length - 1;
    }
    return assistantIdx;
  };
  try {
    let body = text;
    if (s.mode === "plan") body = `[PLAN MODE]\n${text}`;
    if (s.mode === "ask") body = `[ASK MODE - read-only]\n${text}`;
    const pendingAgent = (s as unknown as Record<string, unknown>)["pendingAgent"] as string | undefined;
    // Only pass an explicit provider/id ref as model — the friendly display
    // name (s.modelLabel) is not a valid ModelRef and would be rejected.
    const model = s.modelLabel.includes("/") && !s.modelLabel.includes(" ") ? s.modelLabel : undefined;
    const agent = pendingAgent ?? (s.mode === "plan" ? "plan" : undefined);
    (s as unknown as Record<string, unknown>)["pendingAgent"] = undefined;
    // Snapshot BEFORE sending: session.prompt can resolve after execution
    // completes, so anything new must be diffed against the pre-send state.
    const pre = await BE.listMessages(sessionID).catch(() => []);
    const preIds = new Set(pre.map((m) => m.id));
    const renderedIds = new Set<string>();
    if (opts?.run) await opts.run(body);
    else await BE.sendPrompt(sessionID, body, { model, agent, files: opts?.files });
    s.statusMsg = ""; // status line above the box already shows the phase
    const merge = (msgs: BE.Msg[]) => {
      // Server lists newest-first; append in chronological order.
      const fresh = msgs
        .filter((m) => !preIds.has(m.id) && !renderedIds.has(m.id) && !m.role.startsWith("user") && m.text.trim());
      // Live events already drew this turn's tool lines — don't duplicate them.
      let liveToolThisTurn = false;
      for (const idx of s.toolLineById.values()) if (idx >= turnStart) { liveToolThisTurn = true; break; }
      for (const m of [...fresh].reverse()) {
        renderedIds.add(m.id);
        if (m.role.includes("tool")) {
          if (liveToolThisTurn) continue; // rendered live from session.tool.* events
          s.transcript.push({ role: "tool", text: m.text.slice(0, 3000) });
        }
        else if (m.role === "idle") { /* execution settled marker, nothing to show */ }
        else if (/^\[tool:[^\]]+\]$/.test(m.text.trim()) && liveToolThisTurn) {
          // tool-part placeholder — already rendered as a live tool line
          continue;
        }
        else {
          // Authoritative text: replace the live-streamed entry if we have one.
          let target = -1;
          for (let i = s.transcript.length - 1; i >= turnStart; i--) {
            if (s.transcript[i].role === "assistant") { target = i; break; }
          }
          if (target === -1) {
            s.transcript.push({ role: "assistant", text: m.text });
            assistantIdx = s.transcript.length - 1;
          } else if (target === s.liveAssistantIdx) {
            // live entry already holds the same content — replace with server copy
            s.transcript[target] = { role: "assistant", text: m.text };
            assistantIdx = target;
          } else {
            const cur = s.transcript[target].text;
            s.transcript[target] = { role: "assistant", text: (cur + "\n" + m.text).trim() };
            assistantIdx = target;
          }
        }
      }
      const sig = msgs.filter((m) => !preIds.has(m.id)).map((m) => `${m.id}:${m.text.length}`).join("|");
      return sig;
    };
    let lastSig = "";
    let quiet = 0;
    for (let i = 0; i < 180 && mySeq === submitSeq; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      s.streaming = true; // own the indicator until this turn settles
      const msgs = await BE.listMessages(sessionID).catch(() => []);
      const sig = merge(msgs);
      if (sig === lastSig) quiet++;
      else { quiet = 0; lastSig = sig; }
      // Settle = quiet AND we actually rendered a response. Stable signature
      // with only our own echo means "no response yet", not "done".
      if (renderedIds.size > 0 && quiet >= 2) break; // ~3s with no new content = settled
      if (renderedIds.size === 0 && i >= 160) break; // no response after ~4min, stop quietly
    }
    if (mySeq === submitSeq) {
      // final sync in case anything landed between polls
      const msgs = await BE.listMessages(sessionID).catch(() => []);
      merge(msgs);
      s.statusMsg = "";
    }
  } catch (e) {
    s.transcript.push({ role: "error", text: `opencode error: ${String(e)}` });
    s.statusMsg = "";
  } finally {
    if (mySeq === submitSeq) {
      s.streaming = false;
      s.phase = "idle";
      s.liveAssistantId = null;
      s.liveAssistantIdx = null;
      s.seenOrdinals.clear();
      s.toolLineById.clear();
      freezeToolTimers(s);
      s.tokenDisplay = s.turnTokens;
      // completion stamp: "✓ done in 6.2s · 389 tokens", fades after ~3s
      s.stamp = { at: Date.now(), durMs: Date.now() - t0, tokens: s.turnTokens, until: Date.now() + 3000 };
      void refreshContextPct(s, sessionID);
    }
  }
}

async function eventPump(s: UIState, getSession: () => string, isAuto: () => boolean, redraw: () => void) {
  let backoff = 1000;
  // cursor-style tool line text from a tool call input
  const toolLineText = (name: string, input: Record<string, unknown>): string => {
    const inStr = (k: string) => (typeof input[k] === "string" ? String(input[k]) : "");
    if (/shell|bash|exec|run|terminal/i.test(name)) {
      const cmd = inStr("command") || inStr("cmd");
      if (cmd) return `$ ${cmd}`;
      return "$ Running command\u2026";
    }
    const fp = inStr("filePath") || inStr("path") || inStr("file");
    if (fp) return `Editing ${fp.split("/").pop() ?? fp}`;
    const desc = inStr("description") || inStr("prompt");
    if (desc) return `${name}: ${desc.slice(0, 80)}`;
    return `${name}\u2026`;
  };
  const doneText = (text: string, ok: boolean): string => {
    const base = text.replace(/\s*Waiting for approval\.\.\.$/, "");
    return ok ? base : `\u2717 ${base}`;
  };
  for (;;) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1000 * 60 * 10);
      for await (const raw of BE.subscribeEvents(ctl.signal)) {
        backoff = 1000;
        const ev = raw as Record<string, unknown>;
        const type = String(ev["type"] ?? "");
        const props = ((ev["properties"] ?? ev["data"] ?? {}) as Record<string, unknown>);
        const sid = String((props["sessionID"] as string) ?? (ev["sessionID"] as string) ?? "");
        if (sid && sid !== getSession()) continue;

        if (type === "permission.asked") {
          const reqId = String(props["id"] ?? props["requestID"] ?? "");
          const action = String(props["action"] ?? "allow");
          const resources = Array.isArray(props["resources"]) ? (props["resources"] as string[]) : [];
          const save = Array.isArray(props["save"]) ? (props["save"] as unknown[]) : [];
          const message = typeof props["message"] === "string" ? (props["message"] as string) : undefined;
          if (reqId) {
            if (isAuto()) {
              try { await BE.replyPermission(getSession(), reqId, "once"); } catch { /* */ }
            } else {
              s.permission = { id: reqId, action, resources, message, hasSave: save.length > 0 };
              // inline "Waiting for approval..." on the matching shell line
              const head = resources[0]?.split(/\s+/)[0];
              if (head) {
                for (let i = s.transcript.length - 1; i >= 0; i--) {
                  const it = s.transcript[i];
                  if (it.role === "tool" && it.text.includes(head) && !it.text.includes("Waiting for approval")) {
                    it.text += " Waiting for approval...";
                    break;
                  }
                }
              }
            }
          }
          redraw();
        } else if (type === "permission.replied") {
          s.permission = null;
          for (const it of s.transcript) {
            if (it.role === "tool" && it.text.includes("Waiting for approval")) {
              it.text = it.text.replace(/\s*Waiting for approval\.\.\./, "");
            }
          }
          redraw();
        } else if (type === "session.text.delta") {
          // Live token streaming (cursor-style): append deltas as they arrive.
          const mid = String(props["assistantMessageID"] ?? "");
          const ordinal = Number(props["ordinal"] ?? -1);
          const delta = String(props["delta"] ?? "");
          if (mid && delta) {
            if (s.liveAssistantId !== mid) {
              s.liveAssistantId = mid;
              s.transcript.push({ role: "assistant", text: "" });
              s.liveAssistantIdx = s.transcript.length - 1;
              s.seenOrdinals.clear();
            }
            const seen = s.seenOrdinals.get(mid) ?? -1;
            if (ordinal > seen) {
              s.seenOrdinals.set(mid, ordinal);
              // deltas belong to the live assistant entry, even when a tool
              // line was pushed after it
              const item = s.liveAssistantIdx != null ? s.transcript[s.liveAssistantIdx] : s.transcript[s.transcript.length - 1];
              if (item && item.role === "assistant") item.text += delta;
            }
            s.streaming = true;
            if (s.phase !== "running") s.phase = "running";
            redraw();
          }
        } else if (type === "session.usage.updated") {
          const tok = (props["tokens"] ?? {}) as Record<string, number>;
          s.turnTokens = Math.max(0, Number(tok["output"] ?? 0) - s.turnBaseline);
          redraw();
        } else if (
          type === "session.execution.succeeded" || type === "session.execution.failed" ||
          type === "session.execution.interrupted" || type === "session.idle"
        ) {
          s.streaming = false;
          s.phase = "idle";
          s.statusMsg = "";
          freezeToolTimers(s); // interrupted tools stop counting
          // final sync of the streamed message happens in submit()'s merge
          s.liveAssistantId = null;
          s.seenOrdinals.clear();
          redraw();
        } else if (type === "session.tool.called") {
          const toolId = String(props["id"] ?? "");
          const input = (props["input"] ?? {}) as Record<string, unknown>;
          const name = s.toolNameById.get(toolId) ?? String(props["tool"] ?? props["name"] ?? "tool");
          s.transcript.push({ role: "tool", text: toolLineText(name, input), toolId, startedAt: Date.now() });
          s.toolLineById.set(toolId, s.transcript.length - 1);
          s.streaming = true;
          if (s.phase === "idle") s.phase = "working";
          redraw();
        } else if (type === "session.tool.input.started") {
          // carries the real tool name for this call id — learn it for line text
          const toolId = String(props["id"] ?? "");
          const name = String(props["name"] ?? "");
          if (toolId && name) {
            const had = s.toolNameById.has(toolId);
            s.toolNameById.set(toolId, name);
            const idx = s.toolLineById.get(toolId);
            if (!had && idx !== undefined && s.transcript[idx] && s.transcript[idx].text === "tool…") {
              s.transcript[idx].text = `${name}…`;
              redraw();
            }
            // execution begins here (post-approval) — start the elapsed timer here
            if (idx !== undefined && s.transcript[idx]?.startedAt != null && s.transcript[idx].endedAt == null) {
              s.transcript[idx].startedAt = Date.now();
            }
          }
        } else if (type === "session.tool.input.ended") {
          // data.text is the JSON-encoded tool input — re-render, never show raw JSON
          const toolId = String(props["id"] ?? "");
          const idx = s.toolLineById.get(toolId);
          const raw = String(props["text"] ?? "");
          if (idx !== undefined && s.transcript[idx] && raw) {
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              const name = s.toolNameById.get(toolId) ?? "tool";
              s.transcript[idx].text = toolLineText(name, parsed);
            } catch { /* keep existing line */ }
            redraw();
          }
        } else if (type === "session.tool.success" || type === "session.tool.failed") {
          const toolId = String(props["id"] ?? "");
          const failed = type === "session.tool.failed";
          const idx = s.toolLineById.get(toolId);
          if (idx !== undefined && s.transcript[idx]) {
            const it = s.transcript[idx];
            it.text = it.text.replace(/\s*Waiting for approval\.\.\./, "");
            it.endedAt = Date.now();
            // shell tool output feeds the collapsible transcript block
            if (/^\s*\$\s/.test(it.text)) {
              const content = (props["content"] ?? []) as Array<{ type?: string; text?: string }>;
              if (Array.isArray(content)) {
                const joined = content
                  .filter((p) => p && p.type === "text" && typeof p.text === "string")
                  .map((p) => p.text as string)
                  .join("\n")
                  .replace(/\s+$/, "");
                if (joined) it.output = joined.split("\n").slice(-200);
              }
            }
            if (failed && !it.text.startsWith("\u2717")) it.text = `\u2717 ${it.text}`;
          }
          redraw();
        } else if (type === "session.model.selected") {
          const ref = (props["model"] ?? {}) as { id?: string; providerID?: string };
          if (ref.id && ref.providerID) {
            void BE.friendlyModelName({ providerID: ref.providerID, id: ref.id }).then((n) => { s.modelLabel = n; });
            // context window changed — recompute limit and the % readout
            void BE.modelContextLimit({ providerID: ref.providerID, id: ref.id }).then((lim) => {
              s.contextLimit = lim;
              void refreshContextPct(s, getSession());
            });
          }
        } else if (type === "command.updated") {
          // project .opencode/command/*.md changed on disk — reload the list
          s.ocCommands = (await BE.listCommands(s.cwd)).map((c) => ({ name: "/" + c.name, desc: c.description ?? "" }));
          redraw();
        } else if (type === "session.status") {
          const st = String((props["status"] as Record<string, unknown> | undefined)?.["type"] ?? "");
          if (st === "busy") { s.streaming = true; if (s.phase === "idle") s.phase = "working"; redraw(); }
        } else if (type.startsWith("session.inbox.")) {
          // task counter: refresh pending inbox count (9b)
          try {
            const items = await BE.inboxList(getSession());
            s.taskCount = items.length;
            redraw();
          } catch { /* ignore */ }
        }
      }
      clearTimeout(timer);
    } catch {
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(10000, backoff * 2);
    }
  }
}

await main();
