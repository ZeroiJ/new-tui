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

type ServerInfoFn = { server: { info: (o?: unknown) => Promise<{ version: string }> } };

export async function getServerInfo(): Promise<{ version?: string } | null> {
  try {
    const cl = (await getClient()) as unknown as ServerInfoFn;
    return await cl.server.info();
  } catch {
    return null;
  }
}

/** Friendly display name for a model ref, e.g. "MiMo-V2.6-Flash Free". */
export async function friendlyModelName(ref: { providerID: string; id: string } | null | undefined): Promise<string> {
  if (!ref) return "Auto";
  try {
    const models = await listModels();
    const hit = models.find(
      (m) => String(m["id"]) === ref.id && String(m["providerID"] ?? m["provider"]) === ref.providerID,
    );
    if (hit) return String(hit["name"] ?? hit["modelID"] ?? hit["id"]);
  } catch { /* fall through */ }
  return `${ref.providerID}/${ref.id}`;
}

export async function getDefaultModelName(): Promise<string> {
  try {
    const cl = (await getClient()) as unknown as { model: { default: (o?: unknown) => Promise<unknown> } };
    const raw = (await cl.model.default()) as { data?: { name?: string; modelID?: string; id?: string } | null } | { name?: string } | null;
    const d = ("data" in (raw ?? {}) ? (raw as { data?: unknown }).data : raw) as
      | { name?: string; modelID?: string; id?: string }
      | null
      | undefined;
    if (d) return String(d.name ?? d.modelID ?? d.id ?? "Auto");
  } catch { /* fall through */ }
  return "Auto";
}

/** Context window size for a model ref (ModelInfo.limit.context); 0 = unknown. */
export async function modelContextLimit(ref: { providerID: string; id: string } | null | undefined): Promise<number> {
  try {
    if (ref) {
      const models = await listModels();
      const hit = models.find(
        (m) => String(m["id"]) === ref.id && String(m["providerID"] ?? m["provider"]) === ref.providerID,
      );
      const lim = Number((hit?.["limit"] as { context?: number } | undefined)?.context ?? 0);
      if (lim > 0) return lim;
    }
    // fall back to the default model's window
    const cl = (await getClient()) as unknown as { model: { default: (o?: unknown) => Promise<unknown> } };
    const raw = (await cl.model.default()) as Record<string, unknown> | null;
    const d = (raw && "data" in raw ? (raw as { data?: unknown }).data : raw) as
      | { limit?: { context?: number } }
      | null
      | undefined;
    return Number(d?.limit?.context ?? 0);
  } catch {
    return 0;
  }
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
    const cl = await c();
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

export async function switchModel(sessionID: string, model: { providerID: string; id: string; variant?: string }) {
  const cl = (await c()) as unknown as { session: { switchModel: (o: unknown) => Promise<unknown> } };
  await cl.session.switchModel({ sessionID, model });
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
    command: (o: unknown) => Promise<unknown>;
  };
  command: { list: (o?: unknown) => Promise<unknown> };
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

export interface FileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

export async function vcsDiff(directory: string): Promise<FileDiff[]> {
  const cl = (await getClient()) as unknown as {
    vcs: { diff: (o: unknown) => Promise<{ data?: FileDiff[] } | FileDiff[]> };
  };
  const r = await cl.vcs.diff({ location: { directory }, mode: "working" });
  const arr = Array.isArray(r) ? r : (r?.data ?? []);
  return arr;
}

export async function inboxList(sessionID: string): Promise<unknown[]> {
  const cl = (await getClient()) as unknown as {
    session: { inbox: { list: (o: unknown) => Promise<unknown[]> } };
  };
  return await cl.session.inbox.list({ sessionID });
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

export interface OcCommand {
  name: string;
  description?: string;
}

/** opencode's own commands (built-in + project `.opencode/command` markdown). */
export async function listCommands(directory?: string): Promise<OcCommand[]> {
  const cl = await c();
  try {
    const r = await cl.command.list(directory ? { location: { directory } } : undefined);
    const arr = (Array.isArray(r) ? r : ((r as { data?: Array<Record<string, unknown>> } | null)?.data ?? [])) as Array<Record<string, unknown>>;
    return arr
      .map((c) => ({ name: String(c["name"] ?? ""), description: c["description"] ? String(c["description"]) : undefined }))
      .filter((c) => c.name !== "");
  } catch {
    return [];
  }
}

/** Execute an opencode command — runs server-side like a prompt, so it streams. */
export async function runCommand(sessionID: string, name: string, text: string) {
  const cl = await c();
  await cl.session.command({ sessionID, name, text });
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
