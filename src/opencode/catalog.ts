// Catalogs: models, agents, commands, MCP servers, and permissions.

import { client, unwrap } from "./client";

// --- models ---------------------------------------------------------------

export async function listModels(): Promise<Array<Record<string, unknown>>> {
  const cl = await client();
  try {
    return unwrap<Array<Record<string, unknown>>>(await cl.model.list()) ?? [];
  } catch {
    return [];
  }
}

async function defaultModel(): Promise<Record<string, unknown> | null> {
  try {
    const cl = await client();
    const raw = (await cl.model.default()) as Record<string, unknown> | null;
    return (raw && "data" in raw ? (raw as { data?: unknown }).data : raw) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

export async function getDefaultModelName(): Promise<string> {
  const d = await defaultModel();
  return d ? String(d["name"] ?? d["modelID"] ?? d["id"] ?? "Auto") : "Auto";
}

/** Friendly display name for a model ref, e.g. "MiMo-V2.6-Flash Free". */
export async function friendlyModelName(ref: { providerID: string; id: string } | null | undefined): Promise<string> {
  if (!ref) return "Auto";
  try {
    const hit = (await listModels()).find(
      (m) => String(m["id"]) === ref.id && String(m["providerID"] ?? m["provider"]) === ref.providerID,
    );
    if (hit) return String(hit["name"] ?? hit["modelID"] ?? hit["id"]);
  } catch { /* fall through */ }
  return `${ref.providerID}/${ref.id}`;
}

/** Context window size for a model ref (ModelInfo.limit.context); 0 = unknown. */
export async function modelContextLimit(ref: { providerID: string; id: string } | null | undefined): Promise<number> {
  try {
    if (ref) {
      const hit = (await listModels()).find(
        (m) => String(m["id"]) === ref.id && String(m["providerID"] ?? m["provider"]) === ref.providerID,
      );
      const lim = Number((hit?.["limit"] as { context?: number } | undefined)?.context ?? 0);
      if (lim > 0) return lim;
    }
    const d = await defaultModel();
    return Number((d?.["limit"] as { context?: number } | undefined)?.context ?? 0);
  } catch {
    return 0;
  }
}

// --- agents ---------------------------------------------------------------

export async function listAgents(): Promise<Array<Record<string, unknown>>> {
  const cl = await client();
  try {
    return unwrap<Array<Record<string, unknown>>>(await cl.agent.list()) ?? [];
  } catch {
    return [];
  }
}

// --- commands -------------------------------------------------------------

export interface OcCommand {
  name: string;
  description?: string;
}

/** opencode's own commands (built-in + project `.opencode/command` markdown). */
export async function listCommands(directory?: string): Promise<OcCommand[]> {
  const cl = await client();
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

// --- mcp ------------------------------------------------------------------

export async function listMcp(): Promise<unknown> {
  const cl = await client();
  try {
    return unwrap<unknown>(await cl.mcp.list()) ?? [];
  } catch {
    return [];
  }
}

// --- permissions ----------------------------------------------------------

export async function replyPermission(
  sessionID: string,
  requestID: string,
  decision: "once" | "always" | "reject",
) {
  const cl = await client();
  await cl.permission.reply({ sessionID, requestID, decision });
}
