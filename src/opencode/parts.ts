// opencode's part model: session → message → part. This is the authoritative
// shape the TUI mirrors; the transcript is a view over it.

import type { MessageRecord, PartRecord, PartType, ToolState, ToolStatus } from "../state";

export function msgRole(m: Record<string, unknown>): string {
  return String((m["type"] as string) ?? (m["role"] as string) ?? (m["kind"] as string) ?? "assistant").toLowerCase();
}

function toolStatus(state: Record<string, unknown> | undefined): ToolStatus {
  const s = String(state?.["status"] ?? "");
  if (s === "completed") return "completed";
  if (s === "error") return "error";
  if (s === "running") return "running";
  return "pending";
}

/** Normalize one raw part from `message.list` into our record. */
export function readPart(raw: Record<string, unknown>, messageID: string, sessionID: string): PartRecord | null {
  const type = String(raw["type"] ?? "") as PartType;
  const id = String(raw["id"] ?? "");
  if (!id) return null;
  const base: PartRecord = {
    id,
    messageID,
    sessionID,
    type,
    created: Number((raw["time"] as Record<string, unknown> | undefined)?.["created"] ?? 0),
  };
  switch (type) {
    case "text":
      return { ...base, text: String(raw["text"] ?? "") };
    case "reasoning":
      return { ...base, text: String(raw["text"] ?? "") };
    case "tool": {
      const st = raw["state"] as Record<string, unknown> | undefined;
      const time = st?.["time"] as { start?: number; end?: number } | undefined;
      const state: ToolState = {
        status: toolStatus(st),
        input: (st?.["input"] as Record<string, unknown> | undefined) ?? (raw["input"] as Record<string, unknown> | undefined),
        output: st?.["output"] ? String(st["output"]) : undefined,
        error: st?.["error"] ? String(st["error"]) : undefined,
        title: st?.["title"] ? String(st["title"]) : undefined,
        time,
      };
      return { ...base, tool: String(raw["tool"] ?? "tool"), callID: raw["callID"] ? String(raw["callID"]) : undefined, state };
    }
    case "file":
      return { ...base, text: String((raw["filename"] as string) ?? (raw["mime"] as string) ?? "file") };
    default:
      return base; // step-start / step-finish and anything new opencode adds
  }
}

/** Raw tool output text from a part state, split into lines. */
export function toolOutputLines(part: PartRecord | undefined, cap = 200): string[] {
  const raw = part?.state?.output;
  if (!raw) return [];
  const trimmed = raw.replace(/\s+$/, "");
  if (!trimmed) return [];
  return trimmed.split("\n").slice(-cap);
}

/** Tool start/end in ms, when opencode reported them. */
export function toolTiming(part: PartRecord | undefined): { startedAt?: number; endedAt?: number } {
  const t = part?.state?.time;
  return { startedAt: t?.start, endedAt: t?.end };
}

export function readMessage(raw: Record<string, unknown>, sessionID: string): MessageRecord {
  const tokensRaw = raw["tokens"] as MessageRecord["tokens"] | undefined;
  return {
    id: String(raw["id"] ?? ""),
    sessionID,
    role: (msgRole(raw) === "user" ? "user" : "assistant") as MessageRecord["role"],
    created: Number((raw["time"] as Record<string, unknown> | undefined)?.["created"] ?? 0),
    tokens: tokensRaw
      ? {
          input: Number(tokensRaw.input ?? 0),
          output: Number(tokensRaw.output ?? 0),
          reasoning: Number(tokensRaw.reasoning ?? 0),
          cache: { read: Number(tokensRaw.cache?.read ?? 0), write: Number(tokensRaw.cache?.write ?? 0) },
        }
      : undefined,
  };
}

/** Parts of one raw message, in order. Reasoning parts are returned but the
 *  view layer drops them, matching cursor-agent's hidden-thinking style. */
export function readParts(raw: Record<string, unknown>, messageID: string, sessionID: string): PartRecord[] {
  const parts = (raw["content"] ?? raw["parts"] ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(parts)) return [];
  return parts
    .map((p) => readPart(p, messageID, sessionID))
    .filter((p): p is PartRecord => p !== null);
}

/** Flat text for a message, with tool parts reduced to a `[tool:name]` marker. */
export function messageText(raw: Record<string, unknown>): string {
  const parts = (raw["content"] ?? raw["parts"] ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(parts)) return typeof raw["text"] === "string" ? (raw["text"] as string) : "";
  const out: string[] = [];
  for (const p of parts) {
    const t = String(p["type"] ?? "");
    if (t === "text" && typeof p["text"] === "string" && p["text"]) out.push(p["text"] as string);
    else if (t === "tool") {
      const name = String(p["name"] ?? p["tool"] ?? "tool");
      const st = (p["state"] as Record<string, unknown> | undefined)?.["status"];
      out.push(`[tool:${name}${st === "pending" ? " queued" : ""}]`);
    }
  }
  if (out.length === 0 && typeof raw["text"] === "string") return raw["text"] as string;
  return out.join("\n");
}
