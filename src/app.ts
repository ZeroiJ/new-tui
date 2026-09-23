// Application controller: owns the UI state, the terminal, the turn loop and
// the opencode event pump. Everything opencode-specific lives in ./opencode/*,
// everything visual in ./ui/*.

import { ANSI } from "./ui/theme";
import { render } from "./ui/render";
import { splitKeys, takeIncompleteEscape, type Key } from "./ui/keys";
import { commandList } from "./commands";
import { runSlash } from "./slash";
import { createState, freezeToolTimers, type UIState, type SessionItem } from "./state";
import { OtuiShell } from "./otui/shell";
import * as oc from "./opencode";

let submitSeq = 0;

export interface AppOptions {
  workspace: string;
  mode?: "agent" | "plan" | "ask";
  model?: string;
  prompt?: string;
  resume?: string;
  continueLast?: boolean;
  /** frame engine: "ansi" (default, string renderer) or "opentui" (native) */
  renderer?: "ansi" | "opentui";
}

export class App {
  s: UIState;
  sessionID = "";
  private opts: AppOptions;
  private history: string[] = [];
  private histIdx = -1;
  private ctrlCCount = 0;
  private attachedFiles: string[] = [];
  /** auto-approve every permission (the /run-everything toggle) */
  autoApprove = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tipTimer: ReturnType<typeof setInterval> | null = null;
  private early: string[] = [];
  private earlyListener: ((b: string) => void) | null = null;
  private pending = "";
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanup: () => void = () => {};
  /** OpenTUI shell — present when the native renderer is selected */
  private shell: OtuiShell | null = null;
  private useOtui = false;

  constructor(opts: AppOptions) {
    this.opts = opts;
    this.s = createState(opts.workspace, "…");
    if (opts.mode) this.s.mode = opts.mode;
    if (opts.model) this.s.modelLabel = opts.model;
  }

  // ----- lifecycle ---------------------------------------------------------

  async start() {
    const s = this.s;
    this.useOtui = this.opts.renderer === "opentui";

    if (this.useOtui) {
      await this.bootstrap();
      this.shell = await OtuiShell.create({
        onKey: (key) => void this.handleKey(key),
        onEdit: () => this.onComposerEdit(),
      });
      this.adoptShellSize();
      this.draw();
      this.startTimers();
      void this.startEventPump();
      this.cleanup = () => this.shell?.destroy();
      process.on("exit", this.cleanup);
      process.on("SIGINT", () => {
        this.cleanup();
        process.exit(0);
      });
      return;
    }

    // Buffer keystrokes typed during async bootstrap so nothing is lost.
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    this.earlyListener = (b: string) => {
      this.early.push(b);
    };
    process.stdin.on("data", this.earlyListener);

    await this.bootstrap();

    process.stdout.write(ANSI.altOn);
    this.cleanup = () => {
      process.stdout.write(ANSI.showCursor + ANSI.altOff);
    };
    process.on("exit", this.cleanup);
    process.on("SIGINT", () => {
      this.cleanup();
      process.exit(0);
    });

    this.draw();
    this.startTimers();
    void this.startEventPump();

    process.stdin.on("data", (buf: string) => void this.onData(buf));
    process.stdin.removeListener("data", this.earlyListener);
    for (const b of this.early.splice(0)) void this.onData(b);

    process.stdout.on("resize", () => {
      s.cols = process.stdout.columns ?? 120;
      s.rows = process.stdout.rows ?? 36;
      this.draw();
    });
  }

  private async bootstrap() {
    const s = this.s;
    try {
      s.statusMsg = "connecting to opencode service…";
      this.draw();
      await oc.getClient();
      s.version = (await oc.getServerInfo())?.version ?? "unknown";
      if (this.opts.resume) this.sessionID = this.opts.resume;
      else if (this.opts.continueLast) {
        // Scoped to this workspace — never attach to another project's turn.
        const latest = await oc.latestWorkspaceSession(s.cwd);
        if (latest) this.sessionID = latest.id;
      }
      if (!this.sessionID) {
        const created = await oc.createSession(s.cwd, "Cursor-look session");
        this.sessionID = String(created["id"]);
      }
      await this.loadHistory();
      await this.resolveModel();
      s.modelItems = (await oc.listModels())
        .map((m) => {
          const id = String(m["id"] ?? "");
          const provider = String(m["providerID"] ?? m["provider"] ?? "");
          return { label: String(m["name"] ?? id), value: `${provider}/${id}` };
        })
        .filter((m) => m.value !== "/");
      try {
        s.taskCount = (await oc.inboxList(this.sessionID)).length;
      } catch { /* leave 0 */ }
      s.ocCommands = (await oc.listCommands(s.cwd)).map((c) => ({ name: "/" + c.name, desc: c.description ?? "" }));
      s.statusMsg = "";
    } catch (e) {
      s.statusMsg = "";
      s.transcript.push({
        role: "error",
        text: `Failed to connect to opencode service: ${String(e)}. Is 'opencode2 service status' healthy?`,
      });
    }
  }

  /** Load a session's history into the transcript + part store. */
  async loadHistory() {
    const s = this.s;
    try {
      const msgs = await oc.listMessages(this.sessionID);
      for (const m of msgs.slice(-30)) {
        s.messages.set(m.message.id, m.message);
        for (const p of m.parts) s.parts.set(p.id, p);
        s.transcript.push({
          role: m.role.startsWith("user") ? "user" : m.role.includes("tool") ? "tool" : "assistant",
          text: m.text,
          messageId: m.id,
        });
      }
      if (msgs.length > 0) s.followUp = true;
    } catch { /* ignore */ }
  }

  async resolveModel() {
    const s = this.s;
    try {
      const sess = await oc.getSession(this.sessionID);
      const mref = sess["model"] as { providerID: string; id: string } | undefined;
      s.modelLabel = mref ? await oc.friendlyModelName(mref) : await oc.getDefaultModelName();
      s.contextLimit = await oc.modelContextLimit(mref ?? null);
    } catch { /* keep default */ }
    void this.refreshContext();
  }

  /** Context % = newest assistant message's prompt tokens ÷ model window. */
  async refreshContext() {
    const s = this.s;
    try {
      if (!s.contextLimit || !this.sessionID) return;
      const u = await oc.lastAssistantUsage(this.sessionID);
      if (!u) {
        s.contextPct = null;
        return;
      }
      const pct = Math.round(((u.input + u.cacheRead) / s.contextLimit) * 1000) / 10;
      s.contextPct = pct > 0 ? Math.min(100, pct) : null;
    } catch { /* keep previous */ }
    this.draw();
  }

  private startTimers() {
    // thinking animation clock, token tick-up, stamp expiry
    this.tickTimer = setInterval(() => {
      const s = this.s;
      if (s.streaming && s.spinStart == null) s.spinStart = Date.now();
      if (!s.streaming) s.spinStart = null;
      if (s.toast && Date.now() >= s.toast.until) s.toast = null;
      let need = s.streaming || !!s.statusMsg || s.stamp != null;
      if (s.stamp && Date.now() >= s.stamp.until) {
        s.stamp = null;
        need = true;
      }
      if (s.tokenDisplay !== s.turnTokens) {
        const d = s.turnTokens - s.tokenDisplay;
        s.tokenDisplay = Math.abs(d) <= 3 ? s.turnTokens : s.tokenDisplay + Math.sign(d) * Math.max(1, Math.ceil(Math.abs(d) / 3));
        need = true;
      }
      if (need) this.draw();
    }, 120);
    this.tipTimer = setInterval(() => {
      this.s.tipIndex++;
      this.draw();
    }, 15000);
  }

  // ----- event pump (opencode → TUI) ---------------------------------------

  private async startEventPump() {
    const ctx: oc.EventContext = {
      s: this.s,
      sessionID: () => this.sessionID,
      isAuto: () => this.autoApprove,
      redraw: () => this.draw(),
      autoReply: (requestID, decision) => oc.replyPermission(this.sessionID, requestID, decision),
      setAutoApprove: (v) => {
        this.autoApprove = v;
      },
      refreshContext: () => void this.refreshContext(),
      tuiCommand: (command) => void this.tuiCommand(command),
      selectSession: (sessionID) => void this.selectSession(sessionID),
      appendPrompt: (text) => this.appendPrompt(text),
    };
    let backoff = 1000;
    for (;;) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 1000 * 60 * 10);
        for await (const ev of oc.subscribeEvents(ctl.signal)) {
          backoff = 1000;
          await oc.applyEvent(ev, ctx);
        }
        clearTimeout(timer);
      } catch {
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(10000, backoff * 2);
      }
    }
  }

  /**
   * opencode drives its clients with TUI commands — same vocabulary its own
   * TUI uses. We map the ones that make sense for this front-end.
   */
  private async tuiCommand(command: string) {
    const s = this.s;
    const page = Math.max(1, Math.floor(s.rows / 2) - 4);
    switch (command) {
      case "session.interrupt":
        await oc.interruptSession(this.sessionID);
        s.streaming = false;
        freezeToolTimers(s);
        break;
      case "session.compact":
        await oc.compactSession(this.sessionID);
        s.transcript.push({ role: "system", text: "Session compacted (server request)." });
        break;
      case "session.new": {
        const created = await oc.createSession(s.cwd, "Cursor-look session");
        await this.switchSession(String(created["id"]));
        break;
      }
      case "session.page.up":
        s.scrollOffset += page;
        break;
      case "session.page.down":
        s.scrollOffset = Math.max(0, s.scrollOffset - page);
        break;
      case "session.line.up":
        s.scrollOffset += 1;
        break;
      case "session.line.down":
        s.scrollOffset = Math.max(0, s.scrollOffset - 1);
        break;
      case "session.half.page.up":
        s.scrollOffset += Math.floor(page / 2);
        break;
      case "session.half.page.down":
        s.scrollOffset = Math.max(0, s.scrollOffset - Math.floor(page / 2));
        break;
      case "session.first":
        s.scrollOffset = Number.MAX_SAFE_INTEGER;
        break;
      case "session.last":
        s.scrollOffset = 0;
        break;
      case "prompt.clear":
        s.input = "";
        s.cursor = 0;
        this.updateSlash();
        break;
      case "prompt.submit":
        await this.submitLine();
        break;
      case "agent.cycle":
        s.mode = s.mode === "agent" ? "plan" : s.mode === "plan" ? "ask" : "agent";
        s.statusMsg = `mode: ${s.mode}`;
        break;
      case "session.share":
        s.statusMsg = "share: copy the session id from /ls";
        break;
      default:
        return; // unknown server command — ignore, like opencode's clients do
    }
    this.draw();
  }

  /** tui.session.select — the server asks this client to show another session. */
  private async selectSession(sessionID: string) {
    if (!sessionID || sessionID === this.sessionID) return;
    await this.switchSession(sessionID);
  }

  private async switchSession(sessionID: string) {
    this.sessionID = sessionID;
    this.s.transcript = [];
    this.s.messages.clear();
    this.s.parts.clear();
    this.s.scrollOffset = 0;
    this.s.followUp = false;
    this.s.toolLineById.clear();
    this.s.toolNameById.clear();
    await this.loadHistory();
    await this.resolveModel();
    this.s.transcript.push({ role: "system", text: `Session → ${sessionID}` });
    this.draw();
  }

  /** tui.prompt.append — server filled the input for us. */
  private appendPrompt(text: string) {
    const s = this.s;
    s.input += (s.input && !s.input.endsWith(" ") ? " " : "") + text;
    s.cursor = s.input.length;
    this.updateSlash();
    this.draw();
  }

  // ----- turn lifecycle ----------------------------------------------------

  /** Submit one turn: opencode runs it, we mirror it. */
  async submit(sessionID: string, text: string, opts?: { files?: string[]; run?: (body: string) => Promise<unknown> }) {
    const s = this.s;
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
      const sess = (await oc.getSession(sessionID)) as { tokens?: { output?: number } };
      s.turnBaseline = Number(sess?.tokens?.output ?? 0);
    } catch {
      s.turnBaseline = 0;
    }
    s.liveAssistantId = null;
    s.liveAssistantIdx = null;
    s.seenOrdinals.clear();
    s.toolLineById.clear();
    s.statusMsg = ""; // phase is shown by the status line above the box
    const turnStart = s.transcript.length; // first index owned by this turn
    let assistantIdx = -1;
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
      const pre = await oc.listMessages(sessionID).catch(() => []);
      const preIds = new Set(pre.map((m) => m.id));
      const renderedIds = new Set<string>();
      if (opts?.run) await opts.run(body);
      else await oc.sendPrompt(sessionID, body, { model, agent, files: opts?.files });
      s.statusMsg = "";

      const merge = (msgs: oc.Msg[]) => {
        // Server lists newest-first; append in chronological order.
        const fresh = msgs.filter(
          (m) => !preIds.has(m.id) && !renderedIds.has(m.id) && !m.role.startsWith("user") && m.text.trim(),
        );
        // Live events already drew this turn's tool lines — don't duplicate them.
        let liveToolThisTurn = false;
        for (const idx of s.toolLineById.values()) if (idx >= turnStart) { liveToolThisTurn = true; break; }
        for (const m of [...fresh].reverse()) {
          renderedIds.add(m.id);
          // keep opencode's message/part store authoritative
          s.messages.set(m.message.id, m.message);
          for (const p of m.parts) s.parts.set(p.id, p);
          if (m.role.includes("tool")) {
            if (liveToolThisTurn) continue; // rendered live from session.tool.* events
            s.transcript.push({ role: "tool", text: m.text.slice(0, 3000), messageId: m.id });
          } else if (m.role === "idle") {
            /* execution settled marker, nothing to show */
          } else if (/^\[tool:[^\]]+\]$/.test(m.text.trim()) && liveToolThisTurn) {
            continue; // tool-part placeholder — already rendered as a live tool line
          } else {
            // Authoritative text: replace the live-streamed entry if we have one.
            let target = -1;
            for (let i = s.transcript.length - 1; i >= turnStart; i--) {
              if (s.transcript[i].role === "assistant") { target = i; break; }
            }
            if (target === -1) {
              s.transcript.push({ role: "assistant", text: m.text, messageId: m.id });
              assistantIdx = s.transcript.length - 1;
            } else if (target === s.liveAssistantIdx) {
              s.transcript[target] = { role: "assistant", text: m.text, messageId: m.id };
              assistantIdx = target;
            } else {
              const cur = s.transcript[target].text;
              s.transcript[target] = { role: "assistant", text: (cur + "\n" + m.text).trim(), messageId: m.id };
              assistantIdx = target;
            }
          }
        }
        return msgs.filter((m) => !preIds.has(m.id)).map((m) => `${m.id}:${m.text.length}`).join("|");
      };

      let lastSig = "";
      let quiet = 0;
      for (let i = 0; i < 180 && mySeq === submitSeq; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        s.streaming = true; // own the indicator until this turn settles
        const msgs = await oc.listMessages(sessionID).catch(() => []);
        const sig = merge(msgs);
        if (sig === lastSig) quiet++;
        else { quiet = 0; lastSig = sig; }
        // Settle = quiet AND we actually rendered a response.
        if (renderedIds.size > 0 && quiet >= 2) break; // ~3s with no new content = settled
        if (renderedIds.size === 0 && i >= 160) break; // no response after ~4min
      }
      if (mySeq === submitSeq) {
        merge(await oc.listMessages(sessionID).catch(() => []));
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
        void this.refreshContext();
      }
    }
  }

  /** Handle one input line: `!shell`, `@files`, `&cloud`, `/command`, prompt. */
  async handleLine(text: string): Promise<string | null> {
    const s = this.s;
    const t = text.trim();

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

    if (t.startsWith("@")) {
      const files = t.slice(1).trim().split(/\s+/).filter(Boolean);
      for (const f of files) {
        try {
          const content = (await Bun.file(`${s.cwd}/${f}`).text().catch(() => null)) ?? (await Bun.file(f).text().catch(() => null));
          if (content) s.transcript.push({ role: "tool", text: `@${f} attached (${content.length} chars)` });
          else s.transcript.push({ role: "error", text: `@${f}: not found` });
        } catch (e) {
          s.transcript.push({ role: "error", text: String(e) });
        }
      }
      if (files.length) {
        await this.submit(this.sessionID, `Attached files: ${files.join(", ")}. ${t.includes(" ") ? t.slice(t.indexOf(" ") + 1) : "Review them."}`, { files });
      }
      return null;
    }

    if (t.startsWith("&")) {
      const task = t.slice(1).trim();
      s.transcript.push({ role: "user", text: `& ${task}` });
      s.transcript.push({ role: "assistant", text: "Cloud handoff is not wired to cursor.com in this clone — continuing locally (opencode session).\nTrack cloud tasks at https://cursor.com/agents" });
      if (task) await this.submit(this.sessionID, task);
      return null;
    }

    if (t.startsWith("/")) {
      const [cmd, ...rest] = t.split(/\s+/);
      return await runSlash(this, cmd, rest.join(" "));
    }

    await this.submit(this.sessionID, text);
    return null;
  }

  // ----- keys --------------------------------------------------------------

  updateSlash() {
    const s = this.s;
    if (s.input.startsWith("/model") && (s.input === "/model" || s.input.startsWith("/model "))) {
      s.slashOpen = false;
      s.modelOpen = true;
      s.modelIndex = 0;
      return;
    }
    s.modelOpen = false;
    // /sessions opens the workspace session picker; text after the space filters it
    if (s.input === "/sessions" || s.input.startsWith("/sessions ")) {
      s.slashOpen = false;
      if (!s.sessionsOpen) void this.loadWorkspaceSessions();
      s.sessionsOpen = true;
      s.sessionIndex = 0;
      return;
    }
    s.sessionsOpen = false;
    if (s.input.startsWith("/")) {
      s.slashOpen = true;
      const space = s.input.indexOf(" ");
      s.slashFilter = (space === -1 ? s.input : s.input.slice(0, space)).trim() || "/";
      const matches = commandList(s).filter((c) => c.name.startsWith(s.slashFilter || "/"));
      s.slashIndex = Math.min(s.slashIndex, Math.max(0, matches.length - 1));
    } else s.slashOpen = false;
  }

  private slashMatches() {
    return commandList(this.s).filter((c) => c.name.startsWith(this.s.slashFilter || "/"));
  }

  /** Sessions created in the current workspace, newest first. */
  async loadWorkspaceSessions(): Promise<SessionItem[]> {
    const s = this.s;
    try {
      const items = await oc.listWorkspaceSessions(s.cwd);
      s.sessionItems = items.map((x) => ({ id: x.id, title: x.title, updated: x.updated }));
    } catch {
      s.sessionItems = [];
    }
    s.sessionIndex = Math.min(s.sessionIndex, Math.max(0, s.sessionItems.length - 1));
    this.draw(); // the picker opened before this list existed — repaint it
    return s.sessionItems;
  }

  /** /sessions rows after the typed filter, in the same order as the popup. */
  private sessionMatches() {
    const s = this.s;
    const q = (s.input.startsWith("/sessions ") ? s.input.slice(10) : "").toLowerCase();
    return s.sessionItems.filter(
      (it) => !q || it.title.toLowerCase().includes(q) || it.id.toLowerCase().includes(q),
    );
  }

  private async submitLine() {
    const s = this.s;
    const text = s.input;
    if (!text.trim()) return;
    s.input = "";
    s.cursor = 0;
    s.slashOpen = false;
    this.histIdx = -1;
    this.history.push(text);
    if (text.trim() === "?") {
      s.hintsOpen = !s.hintsOpen;
      return;
    }
    const newId = await this.handleLine(text);
    if (newId) this.sessionID = newId;
    this.attachedFiles = [];
  }

  async handleKey(key: Key) {
    const s = this.s;
    this.ctrlCCount = key.kind === "ctrl" && key.key === "c" ? this.ctrlCCount + 1 : 0;

    // diff overlay: ↑/↓ scroll, enter pages, esc/ctrl+r closes
    if (s.diffOpen) {
      const room = Math.max(3, s.rows - 4);
      if (key.kind === "up") { s.diffScroll = Math.max(0, s.diffScroll - 1); this.draw(); return; }
      if (key.kind === "down") { s.diffScroll = Math.min(Math.max(0, s.diffLines.length - room), s.diffScroll + 1); this.draw(); return; }
      if (key.kind === "esc" || (key.kind === "ctrl" && key.key === "r")) { s.diffOpen = false; this.draw(); return; }
      if (key.kind === "enter") { s.diffScroll = Math.min(Math.max(0, s.diffLines.length - room), s.diffScroll + room); this.draw(); return; }
      return; // swallow other keys while reviewing
    }

    // permission overlay: y once, tab allowlist, shift+tab run-everything, esc/n reject
    if (s.permission) {
      const p = s.permission;
      if (key.kind === "char" && (key.ch === "y" || key.ch === "a")) {
        s.permission = null;
        s.statusMsg = "allowed once";
        await oc.replyPermission(this.sessionID, p.id, "once").catch((e) => { s.statusMsg = String(e); });
        this.draw();
        return;
      }
      if (key.kind === "tab" && !key.shift) {
        s.permission = null;
        s.statusMsg = "added to allowlist";
        await oc.replyPermission(this.sessionID, p.id, "always").catch((e) => { s.statusMsg = String(e); });
        this.draw();
        return;
      }
      if (key.kind === "tab" && key.shift) {
        s.permission = null;
        this.autoApprove = true;
        s.statusMsg = "Run Everything enabled";
        await oc.replyPermission(this.sessionID, p.id, "always").catch(() => {});
        this.draw();
        return;
      }
      if (key.kind === "char" && (key.ch === "d" || key.ch === "n")) {
        s.permission = null;
        s.statusMsg = "rejected";
        await oc.replyPermission(this.sessionID, p.id, "reject").catch(() => {});
        this.draw();
        return;
      }
      if (key.kind === "esc") {
        s.permission = null;
        s.statusMsg = "skipped — agent informed";
        await oc.replyPermission(this.sessionID, p.id, "reject").catch(() => {});
        this.draw();
        return;
      }
    }

    // /sessions picker — ↑/↓ browse, Enter resumes, Tab copies the id, Esc closes
    if (s.sessionsOpen) {
      const matches = this.sessionMatches();
      const hit = () => matches[Math.min(s.sessionIndex, Math.max(0, matches.length - 1))];
      if (key.kind === "up") { s.sessionIndex = Math.max(0, s.sessionIndex - 1); this.draw(); return; }
      if (key.kind === "down") { s.sessionIndex = Math.min(Math.max(0, matches.length - 1), s.sessionIndex + 1); this.draw(); return; }
      if (key.kind === "enter" && !key.shift) {
        const pick = hit();
        s.sessionsOpen = false;
        s.input = "";
        s.cursor = 0;
        s.slashOpen = false;
        if (pick) await this.switchSession(pick.id);
        this.draw();
        return;
      }
      if (key.kind === "tab" && !key.shift) {
        const pick = hit();
        if (pick) { s.input = `/resume ${pick.id}`; s.cursor = s.input.length; }
        this.draw();
        return;
      }
      if (key.kind === "esc") { s.sessionsOpen = false; s.input = ""; s.cursor = 0; this.draw(); return; }
      if (
        key.kind !== "backspace" && key.kind !== "delete" && key.kind !== "char" &&
        key.kind !== "left" && key.kind !== "right" && key.kind !== "ctrl"
      ) return;
    }

    // model picker navigation — runs before slash/history keys
    if (s.modelOpen) {
      const q = (s.input.startsWith("/model ") ? s.input.slice(7) : "").toLowerCase();
      const matches = s.modelItems
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => !q || m.label.toLowerCase().includes(q) || m.value.toLowerCase().includes(q));
      if (key.kind === "up") { s.modelIndex = Math.max(0, s.modelIndex - 1); this.draw(); return; }
      if (key.kind === "down") { s.modelIndex = Math.min(Math.max(0, matches.length - 1), s.modelIndex + 1); this.draw(); return; }
      if (key.kind === "enter" && !key.shift) {
        const hit = matches[Math.min(s.modelIndex, matches.length - 1)]?.m;
        if (hit) {
          const [providerID, ...rest] = hit.value.split("/");
          try {
            await oc.switchModel(this.sessionID, { providerID, id: rest.join("/") });
            s.modelLabel = hit.label;
            s.statusMsg = `Model → ${hit.label}`;
            s.transcript.push({ role: "system", text: `Model → ${hit.label}` });
            s.contextLimit = await oc.modelContextLimit({ providerID, id: rest.join("/") });
            void this.refreshContext();
          } catch (e) {
            s.transcript.push({ role: "error", text: `switchModel failed: ${String(e)}` });
          }
          s.modelOpen = false;
          s.input = "";
          s.cursor = 0;
          s.slashOpen = false;
        }
        this.draw();
        return;
      }
      if (key.kind === "tab" && !key.shift) {
        const hit = matches[Math.min(s.modelIndex, matches.length - 1)]?.m;
        if (hit) { s.input = `/model ${hit.value}`; s.cursor = s.input.length; }
        this.draw();
        return;
      }
      if (key.kind === "esc") { s.modelOpen = false; s.input = ""; s.cursor = 0; this.draw(); return; }
      if (
        key.kind !== "backspace" && key.kind !== "delete" && key.kind !== "char" &&
        key.kind !== "left" && key.kind !== "right" && key.kind !== "ctrl"
      ) return;
    }

    if (key.kind === "ctrl") {
      if (key.key === "c") {
        if (s.streaming) {
          await oc.interruptSession(this.sessionID).catch(() => {});
          s.streaming = false;
          freezeToolTimers(s);
          s.statusMsg = "interrupted";
          this.draw();
          return;
        }
        if (this.ctrlCCount >= 2 || s.input.length === 0) return this.quitApp();
        s.statusMsg = "press Ctrl+C again to quit";
        this.draw();
        return;
      }
      if (key.key === "l") { s.transcript = []; s.statusMsg = "screen cleared"; this.draw(); return; }
      if (key.key === "o") { s.outputExpanded = !s.outputExpanded; this.draw(); return; } // expand/collapse tool output
      if (key.key === "g") { await this.openEditor(); this.draw(); return; }
      if (key.key === "r") { await this.openDiffOverlay(); this.draw(); return; }
      if (key.key === "u") { s.input = ""; s.cursor = 0; this.updateSlash(); this.draw(); return; }
      if (key.key === "d" && s.input.length === 0) return this.quitApp();
      this.draw();
      return;
    }

    if (key.kind === "esc") {
      if (s.slashOpen) { s.slashOpen = false; this.draw(); return; }
      if (s.hintsOpen) { s.hintsOpen = false; this.draw(); return; }
      if (s.streaming) {
        await oc.interruptSession(this.sessionID).catch(() => {});
        s.streaming = false;
        freezeToolTimers(s);
        s.statusMsg = "interrupted (esc)";
        this.draw();
        return;
      }
      return;
    }

    if (key.kind === "tab") {
      if (key.shift) {
        s.mode = s.mode === "agent" ? "plan" : s.mode === "plan" ? "ask" : "agent";
        s.statusMsg = `mode: ${s.mode}`;
        this.draw();
        return;
      }
      if (s.slashOpen) {
        const m = this.slashMatches()[s.slashIndex];
        if (m) { s.input = m.name + " "; s.cursor = s.input.length; this.updateSlash(); this.draw(); }
        return;
      }
      return;
    }

    if (key.kind === "up") {
      if (s.slashOpen) { s.slashIndex = Math.max(0, s.slashIndex - 1); this.draw(); return; }
      if (this.history.length && this.histIdx < this.history.length - 1) {
        this.histIdx++;
        s.input = this.history[this.history.length - 1 - this.histIdx] ?? "";
        s.cursor = s.input.length;
        this.updateSlash();
        this.draw();
      }
      return;
    }

    if (key.kind === "down") {
      if (s.slashOpen) {
        s.slashIndex = Math.min(this.slashMatches().length - 1, s.slashIndex + 1);
        this.draw();
        return;
      }
      if (this.histIdx > 0) { this.histIdx--; s.input = this.history[this.history.length - 1 - this.histIdx] ?? ""; }
      else { this.histIdx = -1; s.input = ""; }
      s.cursor = s.input.length;
      this.updateSlash();
      this.draw();
      return;
    }

    if (key.kind === "left") { s.cursor = Math.max(0, s.cursor - 1); this.draw(); return; }
    if (key.kind === "right") { s.cursor = Math.min(s.input.length, s.cursor + 1); this.draw(); return; }
    if (key.kind === "backspace") { if (s.cursor > 0) { s.input = s.input.slice(0, s.cursor - 1) + s.input.slice(s.cursor); s.cursor--; } this.updateSlash(); this.draw(); return; }
    if (key.kind === "delete") { s.input = s.input.slice(0, s.cursor) + s.input.slice(s.cursor + 1); this.updateSlash(); this.draw(); return; }
    if (key.kind === "enter") {
      if (key.shift) { s.input = s.input.slice(0, s.cursor) + "\n" + s.input.slice(s.cursor); s.cursor++; this.draw(); return; }
      // slash autocomplete enter picks highlighted
      if (s.slashOpen && !s.input.includes(" ")) {
        const m = this.slashMatches()[s.slashIndex];
        if (m && s.input !== m.name + " ") { s.input = m.name + " "; s.cursor = s.input.length; this.updateSlash(); this.draw(); return; }
      }
      await this.submitLine();
      this.draw();
      return;
    }
    if (key.kind === "char") {
      s.input = s.input.slice(0, s.cursor) + key.ch + s.input.slice(s.cursor);
      s.cursor += key.ch.length;
      this.updateSlash();
      this.draw();
      return;
    }
  }

  async openDiffOverlay() {
    const s = this.s;
    try {
      const diffs = await oc.vcsDiff(s.cwd);
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
  }

  async openEditor() {
    const s = this.s;
    const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
    const tmp = `/tmp/cursor-opencode-${Date.now()}.md`;
    await Bun.write(tmp, s.input);
    if (this.shell) {
      this.shell.suspend(); // release the terminal for the editor
      this.shell = null;
    } else {
      process.stdout.write(ANSI.showCursor + ANSI.altOff);
    }
    try {
      const proc = Bun.spawn([editor, tmp], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      await proc.exited;
      s.input = await Bun.file(tmp).text().catch(() => "");
      s.cursor = s.input.length;
    } finally {
      if (this.useOtui) {
        this.shell = await OtuiShell.create({
          onKey: (key) => void this.handleKey(key),
          onEdit: () => this.onComposerEdit(),
        });
        this.adoptShellSize();
      } else {
        process.stdout.write(ANSI.altOn);
      }
      this.draw();
    }
  }

  quitApp() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.tipTimer) clearInterval(this.tipTimer);
    if (this.shell) {
      this.shell.destroy();
      this.shell = null;
      this.cleanup = () => {};
    } else {
      this.cleanup();
    }
    process.exit(0);
  }

  private async onData(buf: string) {
    const combined = this.pending + buf;
    const { ready, pending } = takeIncompleteEscape(combined);
    this.pending = pending;
    if (pending) {
      // lone ESC arrives as its own read — flush it if nothing follows
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => {
        const tail = this.pending;
        this.pending = "";
        void this.handleKeys(tail);
      }, 40);
    }
    if (ready) await this.handleKeys(ready);
  }

  private async handleKeys(data: string) {
    for (const key of splitKeys(data)) await this.handleKey(key);
  }

  // ----- misc --------------------------------------------------------------

  /** Mirror the OpenTUI composer's text/cursor back into app state. */
  private onComposerEdit() {
    if (!this.shell) return;
    const s = this.s;
    const { input, cursor } = this.shell.readComposer();
    if (input === s.input && cursor === s.cursor) return;
    s.input = input;
    s.cursor = cursor;
    this.updateSlash();
    this.draw();
  }

  private adoptShellSize() {
    if (!this.shell) return;
    const { cols, rows } = this.shell.size;
    this.s.cols = cols;
    this.s.rows = rows;
  }

  draw() {
    if (this.shell) {
      this.shell.sync(this.s);
      return;
    }
    process.stdout.write(render(this.s));
  }

  /** Run an initial prompt (CLI arg) without waiting for the user. */
  promptOnce(text: string) {
    void this.submit(this.sessionID, text);
  }
}
