// opencode event → TUI state. One dispatch table instead of an if/else chain,
// so the state machine reads like opencode's own event vocabulary.
//
// Handles session/message/part lifecycle plus opencode's server→TUI commands
// (tui.command.execute, tui.toast.show, tui.session.select, tui.prompt.append).

import { friendlyModelName, listCommands, modelContextLimit } from "./catalog";
import { inboxList } from "./session";
import { freezeToolTimers } from "../state";
import type { PartRecord, UIState } from "../state";

export interface EventContext {
  s: UIState;
  sessionID: () => string;
  isAuto: () => boolean;
  redraw: () => void;
  autoReply: (requestID: string, decision: "once" | "always" | "reject") => Promise<void>;
  setAutoApprove: (v: boolean) => void;
  /** recompute context % after model / token changes */
  refreshContext: () => void;
  /** server-driven UI action (tui.command.execute) */
  tuiCommand: (command: string) => void;
  /** server asked the TUI to switch sessions (tui.session.select) */
  selectSession: (sessionID: string) => void;
  /** server appended text to the prompt (tui.prompt.append) */
  appendPrompt: (text: string) => void;
}

export type OcEvent = Record<string, unknown>;

export function eventData(ev: OcEvent): Record<string, unknown> {
  return ((ev["data"] ?? ev["properties"] ?? {}) as Record<string, unknown>) ?? {};
}

function toolPart(s: UIState, callID: string, patch: Partial<PartRecord> = {}): PartRecord {
  const id = `tool:${callID}`;
  const prev = s.parts.get(id);
  const next: PartRecord = prev ?? {
    id,
    messageID: "",
    sessionID: "",
    type: "tool",
    created: Date.now(),
    state: { status: "running" },
  };
  Object.assign(next, patch);
  if (patch.state) next.state = { ...(next.state ?? { status: "pending" }), ...patch.state };
  s.parts.set(id, next);
  return next;
}

/** Human-readable one-liner for a tool call, cursor-style. */
function toolLineText(name: string, input: Record<string, unknown>): string {
  const inStr = (k: string) => (typeof input[k] === "string" ? String(input[k]) : "");
  if (/shell|bash|exec|run|terminal/i.test(name)) {
    const cmd = inStr("command") || inStr("cmd");
    return cmd ? `$ ${cmd}` : "$ Running command…";
  }
  const fp = inStr("filePath") || inStr("path") || inStr("file");
  if (fp) return `Editing ${fp.split("/").pop() ?? fp}`;
  const desc = inStr("description") || inStr("prompt");
  if (desc) return `${name}: ${desc.slice(0, 80)}`;
  return `${name}…`;
}

type Handler = (ev: OcEvent, d: Record<string, unknown>, ctx: EventContext) => void | Promise<void>;

const handlers: Record<string, Handler> = {
  // --- permissions --------------------------------------------------------
  "permission.asked": async (_ev, d, ctx) => {
    const { s } = ctx;
    const reqId = String(d["id"] ?? d["requestID"] ?? "");
    if (!reqId) return;
    if (ctx.isAuto()) {
      await ctx.autoReply(reqId, "once").catch(() => {});
      return;
    }
    const save = Array.isArray(d["save"]) ? (d["save"] as unknown[]) : [];
    s.permission = {
      id: reqId,
      action: String(d["action"] ?? "allow"),
      resources: Array.isArray(d["resources"]) ? (d["resources"] as string[]) : [],
      message: typeof d["message"] === "string" ? d["message"] : undefined,
      hasSave: save.length > 0,
    };
    // inline "Waiting for approval..." on the matching shell line
    const head = s.permission.resources[0]?.split(/\s+/)[0];
    if (head) {
      for (let i = s.transcript.length - 1; i >= 0; i--) {
        const it = s.transcript[i];
        if (it.role === "tool" && it.text.includes(head) && !it.text.includes("Waiting for approval")) {
          it.text += " Waiting for approval...";
          break;
        }
      }
    }
    ctx.redraw();
  },

  "permission.replied": (_ev, _d, ctx) => {
    ctx.s.permission = null;
    for (const it of ctx.s.transcript) {
      if (it.role === "tool" && it.text.includes("Waiting for approval")) {
        it.text = it.text.replace(/\s*Waiting for approval\.\.\./, "");
      }
    }
    ctx.redraw();
  },

  // --- assistant text -----------------------------------------------------
  "session.text.delta": (_ev, d, ctx) => {
    const { s } = ctx;
    const mid = String(d["assistantMessageID"] ?? "");
    const ordinal = Number(d["ordinal"] ?? -1);
    const delta = String(d["delta"] ?? "");
    if (!mid || !delta) return;
    if (s.liveAssistantId !== mid) {
      s.liveAssistantId = mid;
      s.transcript.push({ role: "assistant", text: "", messageId: mid });
      s.liveAssistantIdx = s.transcript.length - 1;
      s.seenOrdinals.clear();
    }
    const seen = s.seenOrdinals.get(mid) ?? -1;
    if (ordinal > seen) {
      s.seenOrdinals.set(mid, ordinal);
      // deltas belong to the live assistant entry, even when a tool line was
      // pushed after it
      const item = s.liveAssistantIdx != null ? s.transcript[s.liveAssistantIdx] : s.transcript[s.transcript.length - 1];
      if (item && item.role === "assistant") item.text += delta;
      // mirror into the part store so the part model stays complete
      const part = s.parts.get(`text:${mid}`);
      s.parts.set(`text:${mid}`, {
        id: `text:${mid}`,
        messageID: mid,
        sessionID: ctx.sessionID(),
        type: "text",
        text: (part?.text ?? "") + delta,
        created: part?.created ?? Date.now(),
      });
    }
    s.streaming = true;
    if (s.phase !== "running") s.phase = "running";
    ctx.redraw();
  },

  // opencode streams reasoning too; we record it but keep it out of the view
  "session.reasoning.delta": (_ev, d, ctx) => {
    const mid = String(d["assistantMessageID"] ?? "");
    if (!mid) return;
    const id = `reasoning:${mid}`;
    const prev = ctx.s.parts.get(id);
    ctx.s.parts.set(id, {
      id,
      messageID: mid,
      sessionID: ctx.sessionID(),
      type: "reasoning",
      text: (prev?.text ?? "") + String(d["delta"] ?? ""),
      created: prev?.created ?? Date.now(),
    });
  },

  // --- usage / execution --------------------------------------------------
  "session.usage.updated": (_ev, d, ctx) => {
    const tok = (d["tokens"] ?? {}) as Record<string, number>;
    // usage is session-cumulative; subtract this turn's baseline
    ctx.s.turnTokens = Math.max(0, Number(tok["output"] ?? 0) - ctx.s.turnBaseline);
    ctx.redraw();
  },

  "session.execution.succeeded": (_ev, _d, ctx) => settle(ctx),
  "session.execution.failed": (_ev, _d, ctx) => settle(ctx),
  "session.execution.interrupted": (_ev, _d, ctx) => settle(ctx),
  "session.idle": (_ev, _d, ctx) => settle(ctx),

  "session.status": (_ev, d, ctx) => {
    const st = String(((d["status"] as Record<string, unknown> | undefined)?.["type"]) ?? "");
    if (st === "busy") {
      ctx.s.streaming = true;
      if (ctx.s.phase === "idle") ctx.s.phase = "working";
      ctx.redraw();
    }
  },

  // --- tools --------------------------------------------------------------
  "session.tool.called": (_ev, d, ctx) => {
    const { s } = ctx;
    const callID = String(d["id"] ?? "");
    const input = (d["input"] ?? {}) as Record<string, unknown>;
    const name = s.toolNameById.get(callID) ?? String(d["tool"] ?? d["name"] ?? "tool");
    s.transcript.push({ role: "tool", text: toolLineText(name, input), toolId: callID, partId: `tool:${callID}`, startedAt: Date.now() });
    s.toolLineById.set(callID, s.transcript.length - 1);
    toolPart(s, callID, { tool: name, callID, state: { status: "running", input } });
    s.streaming = true;
    if (s.phase === "idle") s.phase = "working";
    ctx.redraw();
  },

  "session.tool.input.started": (_ev, d, ctx) => {
    // carries the real tool name for this call id — learn it for line text
    const { s } = ctx;
    const callID = String(d["id"] ?? "");
    const name = String(d["name"] ?? "");
    if (!callID || !name) return;
    const had = s.toolNameById.has(callID);
    s.toolNameById.set(callID, name);
    const idx = s.toolLineById.get(callID);
    if (idx !== undefined && s.transcript[idx]) {
      if (!had && s.transcript[idx].text === "tool…") s.transcript[idx].text = `${name}…`;
      // execution begins here (post-approval) — start the elapsed timer here
      if (s.transcript[idx].startedAt != null && s.transcript[idx].endedAt == null) {
        s.transcript[idx].startedAt = Date.now();
      }
    }
    toolPart(s, callID, { tool: name, state: { status: "running" } });
  },

  "session.tool.input.ended": (_ev, d, ctx) => {
    // data.text is the JSON-encoded tool input — re-render, never show raw JSON
    const { s } = ctx;
    const callID = String(d["id"] ?? "");
    const idx = s.toolLineById.get(callID);
    const raw = String(d["text"] ?? "");
    if (idx === undefined || !s.transcript[idx] || !raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const name = s.toolNameById.get(callID) ?? "tool";
      s.transcript[idx].text = toolLineText(name, parsed);
      toolPart(s, callID, { tool: name, state: { status: "running", input: parsed } });
    } catch { /* keep existing line */ }
    ctx.redraw();
  },

  "session.tool.success": (ev, d, ctx) => finishTool(ev, d, ctx, false),
  "session.tool.failed": (ev, d, ctx) => finishTool(ev, d, ctx, true),

  // --- session metadata ---------------------------------------------------
  "session.model.selected": async (_ev, d, ctx) => {
    const ref = (d["model"] ?? {}) as { id?: string; providerID?: string };
    if (!ref.id || !ref.providerID) return;
    const model = { providerID: ref.providerID, id: ref.id };
    ctx.s.modelLabel = await friendlyModelName(model);
    // context window changed — recompute limit and the % readout
    ctx.s.contextLimit = await modelContextLimit(model);
    ctx.refreshContext();
  },

  "session.inbox.delivered": async (_ev, _d, ctx) => refreshInbox(ctx),
  "session.inbox.enqueued": async (_ev, _d, ctx) => refreshInbox(ctx),
  "session.inbox.cancelled": async (_ev, _d, ctx) => refreshInbox(ctx),

  "command.updated": async (_ev, _d, ctx) => {
    ctx.s.ocCommands = (await listCommands(ctx.s.cwd)).map((c) => ({ name: "/" + c.name, desc: c.description ?? "" }));
    ctx.redraw();
  },

  // --- server → TUI commands (opencode drives its clients) ---------------
  "tui.command.execute": (_ev, d, ctx) => ctx.tuiCommand(String(d["command"] ?? "")),
  "tui.session.select": (_ev, d, ctx) => ctx.selectSession(String(d["sessionID"] ?? "")),
  "tui.prompt.append": (_ev, d, ctx) => ctx.appendPrompt(String(d["text"] ?? "")),
  "tui.toast.show": (_ev, d, ctx) => {
    const variant = String(d["variant"] ?? "info") as "info" | "success" | "warning" | "error";
    const duration = Number(d["duration"] ?? 4000);
    const now = Date.now();
    ctx.s.toast = {
      title: typeof d["title"] === "string" ? d["title"] : undefined,
      message: String(d["message"] ?? ""),
      variant,
      at: now,
      until: now + (Number.isFinite(duration) ? duration : 4000),
    };
    ctx.redraw();
  },
};

function settle(ctx: EventContext) {
  const { s } = ctx;
  s.streaming = false;
  s.phase = "idle";
  s.statusMsg = "";
  freezeToolTimers(s);
  s.liveAssistantId = null;
  s.seenOrdinals.clear();
  ctx.redraw();
}

function finishTool(ev: OcEvent, d: Record<string, unknown>, ctx: EventContext, failed: boolean) {
  const { s } = ctx;
  const callID = String(d["id"] ?? "");
  const idx = s.toolLineById.get(callID);
  const now = Number(ev["created"] ?? Date.now());
  const content = (d["content"] ?? []) as Array<{ type?: string; text?: string }>;
  const output = Array.isArray(content)
    ? content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text as string).join("\n")
    : "";

  if (idx !== undefined && s.transcript[idx]) {
    const it = s.transcript[idx];
    it.text = it.text.replace(/\s*Waiting for approval\.\.\./, "");
    it.endedAt = now;
    // shell tool output feeds the collapsible transcript block
    if (/^\s*\$\s/.test(it.text) && output.trim()) {
      it.output = output.replace(/\s+$/, "").split("\n").slice(-200);
    }
    if (failed && !it.text.startsWith("\u2717")) it.text = `\u2717 ${it.text}`;
  }
  toolPart(s, callID, {
    state: {
      status: failed ? "error" : "completed",
      output: output || undefined,
      error: failed ? String((d["error"] as Record<string, unknown> | undefined)?.["message"] ?? "tool failed") : undefined,
      time: { end: now },
    },
  });
  ctx.redraw();
}

async function refreshInbox(ctx: EventContext) {
  try {
    ctx.s.taskCount = (await inboxList(ctx.sessionID())).length;
    ctx.redraw();
  } catch { /* ignore */ }
}

/** Apply one opencode event to the TUI. Unhandled events are ignored. */
export async function applyEvent(ev: OcEvent, ctx: EventContext): Promise<void> {
  const type = String(ev["type"] ?? "");
  const handler = handlers[type];
  if (!handler) return;
  // events for another session never touch our view
  const d = eventData(ev);
  const sid = String((d["sessionID"] as string) ?? (ev["sessionID"] as string) ?? "");
  if (sid && type.startsWith("session.") && sid !== ctx.sessionID()) return;
  try {
    await handler(ev, d, ctx);
  } catch { /* a bad event must never take the pump down */ }
}
