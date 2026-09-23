// Permission prompt and the ctrl+r working-tree diff overlay.

import { bold, dim } from "./theme";
import type { UIState } from "../state";

/** Permission overlay — cursor-agent's menu (divider, context, question, arrow menu). */
export function permissionRows(s: UIState): string[] {
  const p = s.permission;
  if (!p) return [];
  const out: string[] = [dim("─".repeat(Math.max(10, s.cols - 2)))];
  const ctx = p.resources[0] ?? p.action;
  out.push(` $  ${ctx}`);
  out.push(` ${bold(/shell|bash|command|exec/i.test(p.action) ? "Run this command?" : `${p.action.replace(/[._]/g, " ")}?`)}`);
  if (ctx) out.push(dim(` Not in allowlist: ${(ctx.split(/\s+/)[0] ?? ctx).slice(0, 40)}`));
  if (p.message) out.push(dim(` ${p.message.slice(0, s.cols - 4)}`));
  out.push(`  ${bold("→")} Run (once) ${dim("(y)")}`);
  if (p.hasSave) out.push(dim(`    Add ${ctx.split(/\s+/)[0] ?? ctx} to allowlist? (tab)`));
  out.push(dim(`    Run Everything (shift+tab)`));
  out.push(dim(`    Skip & tell the agent what to do instead (esc or n)`));
  const hint = "ctrl+r to review changed files";
  out.push(dim(" " + " ".repeat(Math.max(1, s.cols - hint.length - 2)) + hint));
  return out;
}

/** ctrl+r diff overlay — full-screen review of working-tree changes. */
export function diffOverlay(s: UIState): string {
  const W = s.cols;
  const out: string[] = [
    "\x1b[2J\x1b[H",
    `  ${bold("Changed files")} ${dim("(↑/↓ scroll, esc close)")}`,
    "",
  ];
  const room = Math.max(3, s.rows - 4);
  const scroll = Math.min(s.diffScroll, Math.max(0, s.diffLines.length - room));
  for (const ln of s.diffLines.slice(scroll, scroll + room)) {
    const c = ln.startsWith("+") ? `\x1b[32m${ln}\x1b[0m`
      : ln.startsWith("-") ? `\x1b[31m${ln}\x1b[0m`
      : ln.startsWith("@@") ? `\x1b[36m${ln}\x1b[0m`
      : ln.startsWith(" ") ? dim(ln)
      : ln;
    out.push("  " + (c.length > W ? c.slice(0, W) : c));
  }
  if (s.diffLines.length === 0) out.push(dim("  (no changes)"));
  return out.join("\n");
}
