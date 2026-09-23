// The input box: flat grey panel, block cursor parked inside, and the two
// contextual hints (placeholder swap + right-aligned "ctrl+c to stop").

import { boxBg, dim, shortCwd, softDim } from "./theme";
import { stripAnsi } from "./text";
import type { UIState } from "../state";

export interface Composer {
  rows: string[];
  /** cursor position within the box, relative to its first row */
  cursorLine: number;
  cursorColInLine: number;
}

export function composer(s: UIState): Composer {
  const boxW = Math.max(20, s.cols - 2);
  const placeholder = s.followUp ? "Add a follow-up" : "Plan, search, build anything";
  const lines = s.input.split("\n");
  const rows: string[] = [];
  let remaining = Math.max(0, Math.min(s.cursor, s.input.length));
  let cursorLine = 0;
  let cursorColInLine = 0;

  lines.forEach((ln, idx) => {
    const prefix = idx === 0 ? "→ " : "  ";
    const isEmpty = ln.length === 0 && idx === 0 && s.input.length === 0;
    const body = isEmpty ? softDim(placeholder) : ln;
    const plainLen = 2 + (isEmpty ? placeholder.length : stripAnsi(body).length);
    const padN = Math.max(0, boxW - 1 - plainLen);
    const hint = idx === 0 && s.streaming ? "ctrl+c to stop" : "";
    const roomy = padN > hint.length + 2;
    const pad = roomy ? padN - hint.length - 1 : padN;
    const hintText = roomy ? ` ${softDim(hint)}` : "";
    rows.push(" " + boxBg(` ${prefix}${body}${" ".repeat(pad)}${hintText} `));
    if (idx < lines.length - 1 && remaining > ln.length) {
      remaining -= ln.length + 1;
    } else if (remaining !== -1 && remaining <= ln.length) {
      cursorLine = idx;
      cursorColInLine = remaining;
      remaining = -1;
    }
  });
  if (remaining !== -1) {
    cursorLine = lines.length - 1;
    cursorColInLine = lines[lines.length - 1]?.length ?? 0;
  }
  return { rows, cursorLine, cursorColInLine };
}

/** Model + context + cwd + task lines that sit under the box. */
export function metaRows(s: UIState): string[] {
  const pct = s.contextPct != null && s.contextPct > 0 ? ` · ${s.contextPct}%` : "";
  const label =
    (s.mode === "agent" ? s.modelLabel : s.mode === "plan" ? `Plan · ${s.modelLabel}` : `Ask · ${s.modelLabel}`) + pct;
  return [`  ${dim(label)}`, `  ${dim(shortCwd(s.cwd))}`];
}
