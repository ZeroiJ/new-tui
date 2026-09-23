#!/usr/bin/env bun
import { ANSI, createState, render, splitKeys, SLASH_COMMANDS, type Key, type UIState } from "./ui";
import * as BE from "./backend";

const VERSION = "0.1.0-opencode";
const CURSOR_VERSION_LABEL = "2026.09.18-cursor-look";

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
  const s: UIState = createState(cwd, CURSOR_VERSION_LABEL);
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
    } catch { /* ignore */ }
    // agents/models for labels
    try {
      const agents = await BE.listAgents();
      void agents;
    } catch { /* ignore */ }
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

  // spinner tick
  const tick = setInterval(() => {
    s.spinner++;
    if (s.streaming || s.statusMsg) redraw();
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
    if (s.input.startsWith("/")) {
      s.slashOpen = true;
      const space = s.input.indexOf(" ");
      s.slashFilter = (space === -1 ? s.input : s.input.slice(0, space)).trim() || "/";
      const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(s.slashFilter || "/"));
      s.slashIndex = Math.min(s.slashIndex, Math.max(0, matches.length - 1));
    } else s.slashOpen = false;
  }

  async function handleKey(key: Key) {
    ctrlCCount = key.kind === "ctrl" && key.key === "c" ? ctrlCCount + 1 : 0;

    // permission popup takes a/d
    if (s.permission) {
      if (key.kind === "char" && (key.ch === "a" || key.ch === "y")) {
        const p = s.permission; s.permission = null; s.statusMsg = "allowed once";
        try { await BE.replyPermission(sessionID, p.id, "once"); } catch (e) { s.statusMsg = String(e); }
        redraw(); return;
      }
      if (key.kind === "char" && key.ch === "A") {
        const p = s.permission; s.permission = null; s.statusMsg = "always allowed";
        try { await BE.replyPermission(sessionID, p.id, "always"); } catch (e) { s.statusMsg = String(e); }
        redraw(); return;
      }
      if (key.kind === "char" && (key.ch === "d" || key.ch === "n")) {
        const p = s.permission; s.permission = null; s.statusMsg = "rejected";
        try { await BE.replyPermission(sessionID, p.id, "reject"); } catch (e) { s.statusMsg = String(e); }
        redraw(); return;
      }
      if (key.kind === "esc") { s.permission = null; redraw(); return; }
    }

    if (key.kind === "ctrl") {
      if (key.key === "c") {
        if (s.streaming) { try { await BE.interruptSession(sessionID); } catch { /* */ } s.streaming = false; s.statusMsg = "interrupted"; redraw(); return; }
        if (ctrlCCount >= 2 || s.input.length === 0) { clearInterval(tick); clearInterval(tipTimer); cleanup(); process.exit(0); }
        s.statusMsg = "press Ctrl+C again to quit";
        redraw(); return;
      }
      if (key.key === "l") { s.transcript = []; s.statusMsg = "screen cleared"; redraw(); return; }
      if (key.key === "g") { await openEditor(s); redraw(); return; }
      if (key.key === "u") { s.input = ""; s.cursor = 0; updateSlash(); redraw(); return; }
      if (key.key === "d" && s.input.length === 0) { clearInterval(tick); clearInterval(tipTimer); cleanup(); process.exit(0); }
      redraw(); return;
    }
    if (key.kind === "esc") {
      if (s.slashOpen) { s.slashOpen = false; redraw(); return; }
      if (s.hintsOpen) { s.hintsOpen = false; redraw(); return; }
      if (s.streaming) { try { await BE.interruptSession(sessionID); } catch { /* */ } s.streaming = false; s.statusMsg = "interrupted (esc)"; redraw(); return; }
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
        const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(s.slashFilter || "/"));
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
        const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(s.slashFilter || "/"));
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
        const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(s.slashFilter || "/"));
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
  void eventPump(s, () => sessionID, () => autoApprove);
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
    try {
      const proc = Bun.spawn(["bash", "-c", cmd], { cwd: s.cwd, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      s.transcript.push({ role: "tool", text: `$ ${cmd}\n${(out + err).slice(0, 4000) || "(no output)"}` });
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
    case "/help":
      s.transcript.push({ role: "assistant", text: SLASH_COMMANDS.map((c) => `${c.name} — ${c.desc}`).join("\n") + "\n\nKeys: esc interrupt • Ctrl+L clear • Ctrl+G editor • Shift+Tab mode • \\+Enter newline" });
      return null;
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
        const names = models.slice(0, 20).map((m) => String((m as Record<string, unknown>)["id"] ?? JSON.stringify(m))).join("\n");
        s.transcript.push({ role: "assistant", text: `Models (opencode):\n${names || "(none listed)"}\n\nUse /model <provider/model> to switch.` });
      } else {
        s.modelLabel = arg;
        s.transcript.push({ role: "system", text: `Model → ${arg} (applies to next prompt)` });
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
    case "/diff": {
      try {
        const proc = Bun.spawn(["git", "diff", "--stat"], { cwd: s.cwd, stdout: "pipe", stderr: "pipe" });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        s.transcript.push({ role: "tool", text: out.trim() || "(clean tree)" });
      } catch (e) { s.transcript.push({ role: "error", text: String(e) }); }
      return null;
    }
    default:
      s.transcript.push({ role: "error", text: `Unknown command ${cmd}. Try /help.` });
      return null;
  }
}

let submitSeq = 0;

async function submit(s: UIState, sessionID: string, text: string, opts?: { files?: string[] }) {
  const mySeq = ++submitSeq;
  s.transcript.push({ role: "user", text });
  s.streaming = true;
  s.statusMsg = "sending to opencode…";
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
    const model = s.modelLabel && s.modelLabel !== "Auto" ? s.modelLabel : undefined;
    const agent = pendingAgent ?? (s.mode === "plan" ? "plan" : undefined);
    (s as unknown as Record<string, unknown>)["pendingAgent"] = undefined;
    // Snapshot BEFORE sending: session.prompt can resolve after execution
    // completes, so anything new must be diffed against the pre-send state.
    const pre = await BE.listMessages(sessionID).catch(() => []);
    const preIds = new Set(pre.map((m) => m.id));
    const renderedIds = new Set<string>();
    await BE.sendPrompt(sessionID, body, { model, agent, files: opts?.files });
    s.statusMsg = "streaming…";
    const merge = (msgs: BE.Msg[]) => {
      // Server lists newest-first; append in chronological order.
      const fresh = msgs
        .filter((m) => !preIds.has(m.id) && !renderedIds.has(m.id) && !m.role.startsWith("user") && m.text.trim());
      for (const m of [...fresh].reverse()) {
        renderedIds.add(m.id);
        if (m.role.includes("tool")) s.transcript.push({ role: "tool", text: m.text.slice(0, 3000) });
        else if (m.role === "idle") { /* execution settled marker, nothing to show */ }
        else {
          const idx = ensureAssistant();
          s.transcript[idx] = { role: "assistant", text: (s.transcript[idx].text + "\n" + m.text).trim() };
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
      // still streaming indicator
      s.spinner++;
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
    if (mySeq === submitSeq) s.streaming = false;
  }
}

async function eventPump(s: UIState, getSession: () => string, isAuto: () => boolean) {
  let backoff = 1000;
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
        if (type.includes("PermissionAsked") || type === "permission.asked") {
          const reqId = String(props["id"] ?? props["requestID"] ?? "");
          const action = String(props["action"] ?? "");
          const res = Array.isArray(props["resources"]) ? (props["resources"] as string[]).slice(0, 2).join(", ") : "";
          const text = `${action} ${res}`.trim() || type;
          if (reqId) {
            if (isAuto()) {
              try { await BE.replyPermission(getSession(), reqId, "once"); } catch { /* */ }
            } else {
              s.permission = { id: reqId, text };
            }
          }
        } else if (type.includes("TextDelta") || type.includes("ReasoningDelta") || type.includes("CompactionDelta")) {
          s.streaming = true;
        } else if (type.includes("ExecutionSucceeded") || type.includes("ExecutionFailed") || type.includes("ExecutionInterrupted") || type.includes("Idle")) {
          s.streaming = false;
          s.statusMsg = "";
        } else if (type.includes("ToolCalled") || type.includes("ToolProgress")) {
          const name = String(props["tool"] ?? props["name"] ?? "tool");
          s.statusMsg = `⏺ ${name}…`;
        } else if (type.includes("ToolSuccess") || type.includes("ToolFailed")) {
          s.statusMsg = "";
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
