// Message history and token accounting.

import { client, unwrap } from "./client";
import { messageText, msgRole, readMessage, readParts } from "./parts";
import type { MessageRecord, PartRecord } from "../state";

export interface Msg {
  id: string;
  role: string;
  text: string;
  time?: number;
  message: MessageRecord;
  parts: PartRecord[];
}

export interface HistoryPage {
  messages: Msg[];
}

export async function listMessages(sessionID: string, limit = 50): Promise<Msg[]> {
  const cl = await client();
  const r = unwrap<{ data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
    await cl.message.list({ sessionID, limit }),
  );
  const arr = Array.isArray(r) ? r : (r.data ?? []);
  return arr.map((m) => {
    const message = readMessage(m, sessionID);
    const parts = readParts(m, message.id, sessionID);
    return {
      id: message.id,
      role: msgRole(m),
      text: messageText(m),
      time: message.created,
      message,
      parts,
    };
  });
}

export interface AssistantUsage {
  input: number;
  cacheRead: number;
  output: number;
  time: number;
}

/**
 * Tokens of the newest assistant message — input + cache.read is the context
 * actually sent on that request, which drives the `· 7.5%` model-line readout.
 */
export async function lastAssistantUsage(sessionID: string): Promise<AssistantUsage | null> {
  try {
    const cl = await client();
    const r = unwrap<{ data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
      await cl.message.list({ sessionID, limit: 20 }),
    );
    const arr = Array.isArray(r) ? r : (r.data ?? []);
    let best: AssistantUsage | null = null;
    for (const m of arr) {
      if (!msgRole(m).startsWith("assistant")) continue;
      const t = m["tokens"] as { input?: number; output?: number; cache?: { read?: number } } | undefined;
      if (!t) continue;
      const u: AssistantUsage = {
        input: Number(t.input ?? 0),
        cacheRead: Number(t.cache?.read ?? 0),
        output: Number(t.output ?? 0),
        time: Number((m["time"] as Record<string, unknown> | undefined)?.["created"] ?? 0),
      };
      if (!best || u.time >= best.time) best = u;
    }
    return best;
  } catch {
    return null;
  }
}
