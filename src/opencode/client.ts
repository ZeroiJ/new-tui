// opencode service client: connection bootstrap and the low-level call
// surface every other module in this layer sits on.

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

/** Most SDK responses arrive wrapped in `{ data }`; unwrap those. */
export function unwrap<T>(r: unknown): T {
  const o = r as Record<string, unknown> | null;
  if (o && "data" in o) return o["data"] as T;
  return r as T;
}

/** Typed-ish access to the client surface this TUI uses. */
export type AnyClient = {
  session: {
    list: (o?: unknown) => Promise<unknown>;
    create: (o: unknown) => Promise<unknown>;
    get: (o: unknown) => Promise<unknown>;
    prompt: (o: unknown) => Promise<unknown>;
    command: (o: unknown) => Promise<unknown>;
    switchModel: (o: unknown) => Promise<unknown>;
    interrupt: (o: unknown) => Promise<unknown>;
    compact: (o: unknown) => Promise<unknown>;
    fork: (o: unknown) => Promise<unknown>;
    inbox: { list: (o: unknown) => Promise<unknown[]> };
  };
  message: { list: (o: unknown) => Promise<unknown> };
  model: { list: (o?: unknown) => Promise<unknown>; default: (o?: unknown) => Promise<unknown> };
  agent: { list: (o?: unknown) => Promise<unknown> };
  command: { list: (o?: unknown) => Promise<unknown> };
  permission: { reply: (o: unknown) => Promise<unknown> };
  event: { subscribe: (o?: unknown) => AsyncIterable<Record<string, unknown>> };
  mcp: { list: (o?: unknown) => Promise<unknown> };
  vcs: { diff: (o: unknown) => Promise<{ data?: unknown[] } | unknown[]> };
};

export async function client(): Promise<AnyClient> {
  return (await getClient()) as unknown as AnyClient;
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

/** Subscribe to opencode's event stream (session/message/part/TUI events). */
export async function* subscribeEvents(signal?: AbortSignal): AsyncIterable<Record<string, unknown>> {
  const cl = await client();
  const it = cl.event.subscribe(signal ? { signal } : undefined);
  for await (const ev of it) yield ev;
}
