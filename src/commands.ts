// Slash-command registry. opencode's own commands are the source of truth and
// get merged in at render time; this list is the TUI's local extras.

import type { UIState } from "./state";

export interface SlashCmd {
  name: string;
  desc: string;
  /** "opencode" = served by opencode's own command list, "local" = this TUI */
  source?: "opencode" | "local";
}

export const SLASH_COMMANDS: SlashCmd[] = [
  { name: "/model", desc: "Select model (Tab to edit)" },
  { name: "/agent", desc: "Select agent" },
  { name: "/plan", desc: "Create a plan or show existing plan" },
  { name: "/ask", desc: "Toggle ask mode (Q&A, read-only)" },
  { name: "/compact", desc: "Compact session context" },
  { name: "/fork", desc: "Fork session from latest" },
  { name: "/new", desc: "Start a new session" },
  { name: "/ls", desc: "List sessions" },
  { name: "/resume", desc: "Resume a session by id" },
  { name: "/clear", desc: "Clear screen (Ctrl+L)" },
  { name: "/goal", desc: "Start a durable goal" },
  { name: "/add-dir", desc: "Add a directory to workspace" },
  { name: "/mcp", desc: "MCP servers status" },
  { name: "/sandbox", desc: "Toggle sandbox info" },
  { name: "/run-everything", desc: "Toggle Run Everything" },
  { name: "/auto-review", desc: "Auto-review status" },
  { name: "/spinner", desc: "Pick the thinking animation (/spinner <name>)" },
  { name: "/diff", desc: "Show session diff" },
  { name: "/help", desc: "Show help" },
  { name: "/quit", desc: "Quit (Ctrl+C twice)" },
];

/**
 * opencode's commands first (source of truth), then this TUI's local extras,
 * minus any name opencode already provides.
 */
export function commandList(s: Pick<UIState, "ocCommands">): SlashCmd[] {
  const seen = new Set<string>();
  const out: SlashCmd[] = [];
  for (const c of s.ocCommands) {
    const name = c.name.startsWith("/") ? c.name : "/" + c.name;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, desc: c.desc, source: "opencode" });
  }
  for (const c of SLASH_COMMANDS) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ name: c.name, desc: c.desc, source: "local" });
  }
  return out;
}
