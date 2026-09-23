// Session lifecycle: create/resume/fork, prompt + command submission,
// interrupt, compaction, inbox and vcs.

import { client, unwrap } from "./client";

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export async function listSessions(): Promise<Array<Record<string, unknown>>> {
  const cl = await client();
  return unwrap<Array<Record<string, unknown>>>(await cl.session.list()) ?? [];
}

// ---------------------------------------------------------------------------
// workspace scoping
//
// opencode stores every session centrally, but each one records the directory
// it belongs to. Filtering on that is how a session list becomes "this
// project's sessions" without moving storage (which would need a per-project
// service daemon).
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  title: string;
  directory: string;
  created: number;
  updated: number;
}

export function summarize(raw: Record<string, unknown>): SessionSummary {
  const time = (raw["time"] ?? {}) as { created?: number; updated?: number };
  return {
    id: String(raw["id"] ?? ""),
    title: String(raw["title"] ?? "(untitled)"),
    directory: String((raw["location"] as { directory?: string } | undefined)?.directory ?? ""),
    created: Number(time.created ?? raw["created"] ?? 0),
    updated: Number(time.updated ?? time.created ?? 0),
  };
}

/** Sessions created in `directory`, newest activity first. */
export async function listWorkspaceSessions(directory: string): Promise<SessionSummary[]> {
  const all = (await listSessions()).map(summarize);
  return all
    .filter((s) => s.directory === directory)
    .sort((a, b) => b.updated - a.updated);
}

/** Newest session in `directory` — what --continue attaches to. */
export async function latestWorkspaceSession(directory: string): Promise<SessionSummary | null> {
  return (await listWorkspaceSessions(directory))[0] ?? null;
}

export async function createSession(directory: string, title?: string, model?: string, agent?: string) {
  const cl = await client();
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
  const cl = await client();
  return unwrap<Record<string, unknown>>(await cl.session.get({ sessionID: id }));
}

export async function switchModel(sessionID: string, model: ModelRef) {
  const cl = await client();
  await cl.session.switchModel({ sessionID, model });
}

export interface PromptOptions {
  model?: string;
  agent?: string;
  files?: string[];
}

export async function sendPrompt(sessionID: string, text: string, opts?: PromptOptions) {
  const cl = await client();
  const body: Record<string, unknown> = { sessionID, text };
  if (opts?.files?.length) body["files"] = opts.files.map((p) => ({ uri: p.startsWith("/") ? `file://${p}` : p }));
  if (opts?.agent) body["agent"] = opts.agent;
  if (opts?.model) {
    const [providerID, ...rest] = opts.model.split("/");
    body["model"] = { providerID, id: rest.join("/") };
  }
  return cl.session.prompt(body);
}

/** Execute an opencode command — runs server-side like a prompt, so it streams. */
export async function runCommand(sessionID: string, name: string, text: string) {
  const cl = await client();
  await cl.session.command({ sessionID, name, text });
}

export async function interruptSession(sessionID: string) {
  const cl = await client();
  await cl.session.interrupt({ sessionID });
}

export async function compactSession(sessionID: string) {
  const cl = await client();
  await cl.session.compact({ sessionID });
}

export async function forkSession(sessionID: string) {
  const cl = await client();
  return unwrap<Record<string, unknown>>(await cl.session.fork({ sessionID }));
}

export async function inboxList(sessionID: string): Promise<unknown[]> {
  const cl = await client();
  return await cl.session.inbox.list({ sessionID });
}

export interface FileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

export async function vcsDiff(directory: string): Promise<FileDiff[]> {
  const cl = await client();
  const r = await cl.vcs.diff({ location: { directory }, mode: "working" });
  return (Array.isArray(r) ? r : (r?.data ?? [])) as FileDiff[];
}
