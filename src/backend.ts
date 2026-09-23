import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

export type OCClient = ReturnType<typeof OpenCode.make>;

let _endpoint: { url: string } | null = null;
let _client: OCClient | null = null;

export async function getClient(): Promise<OCClient> {
  if (_client) return _client;
  const endpoint = await Service.ensure();
  _endpoint = endpoint as unknown as { url: string };
  _client = OpenCode.make({
    baseUrl: _endpoint.url,
    headers: Service.headers(endpoint as never),
  }) as unknown as OCClient;
  return _client;
}

export function getServerUrl(): string {
  return _endpoint?.url ?? "";
}

export interface Msg {
  id: string;
  role: string;
  text: string;
  time?: number;
}

type AnyClient = {
  session: {
    list: (o?: unknown) => Promise<unknown>;
    create: (o: unknown) => Promise<unknown>;
    get: (o: unknown) => Promise<unknown>;
    prompt: (o: unknown) => Promise<unknown>;
    interrupt: (o: unknown) => Promise<unknown>;
    compact: (o: unknown) => Promise<unknown>;
    fork: (o: unknown) => Promise<unknown>;
  };
  message: { list: (o: unknown) => Promise<unknown> };
  model: { list: (o?: unknown) => Promise<unknown> };
  agent: { list: (o?: unknown) => Promise<unknown> };
  permission: { reply: (o: unknown) => Promise<unknown> };
  event: { subscribe: (o?: unknown) => AsyncIterable<Record<string, unknown>> };
  mcp: { list: (o?: unknown) => Promise<unknown> };
};

function c(): Promise<AnyClient> {
  return getClient() as unknown as Promise<AnyClient>;
}

function unwrap<T>(r: unknown): T {
  const o = r as Record<string, unknown> | null;
  if (o && "data" in o) return o["data"] as T;
  return r as T;
}

function extractText(m: Record<string, unknown>): string {
  const parts = (m["content"] ?? m["parts"] ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const p of parts) {
    const t = String(p["type"] ?? "");
    if (t === "text" && typeof p["text"] === "string" && p["text"]) out.push(p["text"] as string);
    // reasoning parts are intentionally hidden (matches cursor style:
    // thinking lives in the opencode session, not the transcript).
    else if (t === "tool") {
      const name = String(p["name"] ?? p["tool"] ?? "tool");
      const state = p["executed"] === false ? "queued" : "";
      out.push(`[tool:${name}${state ? ` ${state}` : ""}]`);
    }
  }
  if (out.length === 0 && typeof m["text"] === "string") return m["text"] as string;
  return out.join("\n");
}

function msgRole(m: Record<string, unknown>): string {
  return String((m["type"] as string) ?? (m["role"] as string) ?? (m["kind"] as string) ?? "assistant").toLowerCase();
}

export async function listSessions() {
  const cl = await c();
  return unwrap<Array<Record<string, unknown>>>(await cl.session.list()) ?? [];
}

export async function createSession(directory: string, title?: string, model?: string, agent?: string) {
  const cl = await c();
  const body: Record<string, unknown> = { location: { directory } };
  if (title) body["title"] = title;
  if (agent) body["agent"] = agent;
  if (model) {
    const [providerID, ...rest] = model.split("/");
    body["model"] = { providerID, id: rest.join("/") };
  }
  return unwrap<Record<string, unknown>>(await cl.session.create(body));
}

export async function getSession(id: string) {
  const cl = await c();
  return unwrap<Record<string, unknown>>(await cl.session.get({ sessionID: id }));
}

export async function listMessages(sessionID: string, limit = 50): Promise<Msg[]> {
  const cl = await c();
  const r = unwrap<{ data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(await cl.message.list({ sessionID, limit }));
  const arr = Array.isArray(r) ? r : (r.data ?? []);
  return arr.map((m) => ({
    id: String(m["id"] ?? Math.random()),
    role: msgRole(m),
    text: extractText(m),
    time: Number((m["time"] as Record<string, unknown> | undefined)?.["created"] ?? Date.now()),
  }));
}

export async function sendPrompt(sessionID: string, text: string, opts?: { model?: string; agent?: string; files?: string[] }) {
  const cl = await c();
  const body: Record<string, unknown> = { sessionID, text };
  if (opts?.files?.length) {
    body["files"] = opts.files.map((p) => ({ uri: p.startsWith("/") ? `file://${p}` : p }));
  }
  if (opts?.agent) body["agent"] = opts.agent;
  if (opts?.model) {
    const [providerID, ...rest] = opts.model.split("/");
    body["model"] = { providerID, id: rest.join("/") };
  }
  return cl.session.prompt(body);
}

export async function interruptSession(sessionID: string) {
  const cl = await c();
  await cl.session.interrupt({ sessionID });
}

export async function compactSession(sessionID: string) {
  const cl = await c();
  await cl.session.compact({ sessionID });
}

export async function forkSession(sessionID: string) {
  const cl = await c();
  return unwrap<Record<string, unknown>>(await cl.session.fork({ sessionID }));
}

export async function listModels() {
  const cl = await c();
  try {
    return unwrap<Array<Record<string, unknown>>>(await cl.model.list()) ?? [];
  } catch {
    return [];
  }
}

export async function listAgents() {
  const cl = await c();
  try {
    return unwrap<Array<Record<string, unknown>>>(await cl.agent.list()) ?? [];
  } catch {
    return [];
  }
}

export async function listMcp() {
  const cl = await c();
  try {
    return unwrap<unknown>(await cl.mcp.list()) ?? [];
  } catch {
    return [];
  }
}

export async function replyPermission(sessionID: string, requestID: string, decision: "once" | "always" | "reject") {
  const cl = await c();
  await cl.permission.reply({ sessionID, requestID, decision });
}

export async function* subscribeEvents(signal?: AbortSignal): AsyncIterable<Record<string, unknown>> {
  const cl = await c();
  const it = cl.event.subscribe(signal ? { signal } : undefined);
  for await (const ev of it) yield ev as Record<string, unknown>;
}
