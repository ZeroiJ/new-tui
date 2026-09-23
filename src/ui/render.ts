// Top-level frame assembly: header → transcript → popups → box → meta →
// overlays, with the real terminal cursor parked inside the box.

import { ANSI, dim } from "./theme";
import { transcriptRows } from "./transcript";
import { composer, metaRows } from "./composer";
import { modelPopup, slashPopup } from "./popups";
import { diffOverlay, permissionRows } from "./overlays";
import { hintsRows, statusRows } from "./status";
import { TIPS } from "../tips";
import type { UIState } from "../state";

export function render(s: UIState): string {
  if (s.diffOpen) return diffOverlay(s);

  const now = Date.now();

  // Header — flush to top: Opencode + real service version + rotating tip.
  const head = ["  Opencode", `  ${dim(`v${s.version}`)}`, `  ${dim(TIPS[s.tipIndex % TIPS.length])}`, ""];

  const wrapped = transcriptRows(s);

  // Everything below the transcript, in draw order.
  const tail: string[] = [];
  if (s.modelOpen) tail.push(...modelPopup(s));
  else if (s.slashOpen) tail.push(...slashPopup(s));
  tail.push(...hintsRows(s));
  tail.push(...statusRows(s, now));

  // Input box — the cursor lands inside it, so remember where it starts.
  const boxTopIdx = tail.length;
  const box = composer(s);
  tail.push(...box.rows);
  tail.push(...metaRows(s));
  if (s.taskCount > 0) tail.push(dim(`  ${s.taskCount} task${s.taskCount === 1 ? "" : "s"}`));

  if (s.permission) tail.push(...permissionRows(s));
  else if (s.statusMsg) tail.push(`  ${dim(s.statusMsg)}`);

  // Top-anchored flow like cursor-agent: transcript takes what's left.
  const avail = Math.max(5, s.rows - head.length - tail.length - 1);
  const start = Math.max(0, wrapped.length - avail - s.scrollOffset);
  const visible = wrapped.slice(start, start + avail);

  const out = [ANSI.clear, ...head, ...visible, ...tail];
  const cursorRow = head.length + visible.length + boxTopIdx + 1 + box.cursorLine + 1;
  const cursorCol = box.cursorColInLine + 5;
  return out.join("\n") + `\x1b[${cursorRow};${cursorCol}H` + ANSI.showCursor;
}
