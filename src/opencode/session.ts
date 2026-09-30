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

// ---------------------------------------------------------------------------
// Tier 1: undo/redo, worktrees, export, stats
//
// Shapes verified against the live v2 OpenAPI spec and the running service:
//   session.revert.stage({ sessionID, messageID, files? }) -> Session.Revert
//   session.revert.commit({ sessionID })   — APPLIES the staged revert
//   session.revert.clear({ sessionID })    — discards the staged revert
//   worktree.create({ projectID, name? })  -> { directory }
//   session.export({ sessionID })          -> { info, messages }
//   session.stats({})                      -> aggregate usage
// ---------------------------------------------------------------------------

export interface RevertResult {
  messageID: string;
  snapshot?: string;
  files: FileDiff[];
}

/**
 * Revert the conversation to just before `messageID`, restoring files.
 *
 * opencode's model is stage → commit: staging records a snapshot and the
 * revert point, committing applies it. There is no server-side "unrevert" in
 * v2, so ctui records the undone prompt itself to power /redo.
 */
export async function revertToMessage(
  sessionID: string,
  messageID: string,
  files = true,
): Promise<RevertResult> {
  const cl = await client() as unknown as {
    session: { revert: { stage: (i: unknown) => Promise<unknown>; commit: (i: unknown) => Promise<unknown>; clear: (i: unknown) => Promise<unknown> } };
  };
  const staged = await cl.session.revert.stage({ sessionID, messageID, files });
  await cl.session.revert.commit({ sessionID });
  const data = ((staged as { data?: RevertResult })?.data ?? staged) as RevertResult;
  return { messageID: data?.messageID ?? messageID, snapshot: data?.snapshot, files: data?.files ?? [] };
}

/** Discard a staged revert without applying it. */
export async function clearRevert(sessionID: string): Promise<void> {
  const cl = await client() as unknown as { session: { revert: { clear: (i: unknown) => Promise<unknown> } } };
  await cl.session.revert.clear({ sessionID });
}

export interface ExportedMessage {
  info: Record<string, unknown>;
  parts: unknown[];
}

export interface ExportedSession {
  info: Record<string, unknown>;
  messages: ExportedMessage[];
}

/** Full conversation export (used by /export). */
export async function exportSession(sessionID: string): Promise<ExportedSession> {
  const cl = await client() as unknown as { session: { export: (i: unknown) => Promise<unknown> } };
  const r = await cl.session.export({ sessionID });
  const data = ((r as { data?: ExportedSession })?.data ?? r) as ExportedSession;
  return { info: data?.info ?? {}, messages: Array.isArray(data?.messages) ? data.messages : [] };
}

export interface UsageStats {
  sessions: number;
  subagents: number;
  prompts: number;
  steps: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  cost?: number;
  range?: { from: number; to: number };
}

/** Aggregate usage across sessions (used by /stats). */
export async function usageStats(): Promise<UsageStats> {
  const cl = await client() as unknown as { session: { stats: (i?: unknown) => Promise<unknown> } };
  const r = await cl.session.stats({});
  const d = ((r as { data?: Partial<UsageStats> })?.data ?? r) as Partial<UsageStats>;
  return {
    sessions: Number(d?.sessions ?? 0),
    subagents: Number(d?.subagents ?? 0),
    prompts: Number(d?.prompts ?? 0),
    steps: Number(d?.steps ?? 0),
    tokens: d?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: typeof d?.cost === "number" ? d.cost : undefined,
    range: d?.range,
  };
}

export interface WorktreeInfo {
  directory: string;
  strategy?: string;
}

export async function listWorktrees(projectID: string): Promise<WorktreeInfo[]> {
  const cl = await client() as unknown as { worktree: { list: (i: unknown) => Promise<unknown> } };
  const r = await cl.worktree.list({ projectID });
  const d = ((r as { data?: WorktreeInfo[] })?.data ?? r) as WorktreeInfo[];
  return Array.isArray(d) ? d : [];
}

/** Create an isolated git worktree; returns its directory. */
export async function createWorktree(
  projectID: string,
  name?: string,
  opts: { from?: string; branch?: string } = {},
): Promise<WorktreeInfo> {
  const cl = await client() as unknown as { worktree: { create: (i: unknown) => Promise<unknown> } };
  const r = await cl.worktree.create({ projectID, ...(name ? { name } : {}), ...opts });
  const d = ((r as { data?: WorktreeInfo })?.data ?? r) as WorktreeInfo;
  return { directory: d?.directory ?? "" };
}

export async function removeWorktree(projectID: string, directory: string, force = true): Promise<void> {
  const cl = await client() as unknown as { worktree: { remove: (i: unknown) => Promise<unknown> } };
  await cl.worktree.remove({ projectID, directory, force });
}
