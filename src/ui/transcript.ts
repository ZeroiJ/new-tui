// Transcript layout: prompt blocks, the per-turn thread line (│ … └), tool
// lines with elapsed timers, and collapsible tool output.

import { ANSI, dim, userBlockRow } from "./theme";
import { fmtDur, inlineCode, stripAnsi, wrapText } from "./text";
import type { TranscriptItem, UIState } from "../state";

interface Row {
  plain: string;
  thread: string;
  kind: "content" | "blank" | "block";
  seg: number;
}

/** Is this a shell tool line (`$ cmd`), possibly after a failure mark? */
function isShellLine(item: TranscriptItem): boolean {
  return item.role === "tool" && /^\s*(?:\u2717\s*)?\$\s/.test(item.text);
}

export function transcriptRows(s: UIState): string[] {
  const W = s.cols;
  const now = Date.now();
  const rows: Row[] = [];
  let seg = -1; // segment id: -1 = before the first prompt (never guttered)

  s.transcript.forEach((item, itemIdx) => {
    if (item.role === "user") {
      // prompt block: pad / text / pad — the thread line starts just below it
      seg++;
      const blank = userBlockRow("", W);
      rows.push({ plain: blank, thread: blank, kind: "block", seg });
      for (const ln of wrapText(item.text, Math.max(20, W - 3))) {
        const row = userBlockRow(" " + ln, W);
        rows.push({ plain: row, thread: row, kind: "block", seg });
      }
      rows.push({ plain: blank, thread: blank, kind: "block", seg });
      rows.push({ plain: "", thread: "", kind: "blank", seg });
      return;
    }

    const shell = isShellLine(item);
    const plainIndent = item.role === "tool" ? (shell ? 1 : 4) : 2;
    const mk = (inner: string, ind: number) => {
      rows.push({
        plain: " ".repeat(ind) + inner,
        thread: " ".repeat(Math.max(0, ind - 2)) + inner,
        kind: "content",
        seg,
      });
    };
    const color = (t: string) =>
      item.role === "tool" || item.role === "system"
        ? dim(t)
        : item.role === "error"
          ? `\x1b[31m${t}${ANSI.reset}`
          : t;

    const wrapW = Math.max(20, W - 6);
    const lines = wrapText(item.text, wrapW);
    lines.forEach((ln, li) => {
      let inner = item.role === "assistant" ? inlineCode(ln) : color(ln);
      // tool elapsed timer: live while the call is open, frozen once it ends
      if (item.role === "tool" && li === 0 && item.startedAt != null) {
        const ms = (item.endedAt ?? (s.streaming ? now : item.startedAt)) - item.startedAt;
        inner += ` ${dim(fmtDur(ms))}`;
      }
      // inverse block at the tip of live-streamed text
      if (item.role === "assistant" && s.streaming && itemIdx === s.liveAssistantIdx && li === lines.length - 1) {
        inner += `\x1b[7m \x1b[27m`;
      }
      mk(inner, plainIndent);
    });

    // collapsible tool output: marker + last two lines, full list on ctrl+o
    if (item.output && item.output.length > 0) {
      const shown = s.outputExpanded
        ? item.output
        : item.output.length > 2
          ? item.output.slice(-2)
          : item.output;
      const hidden = item.output.length - shown.length;
      if (hidden > 0) mk(dim(`… ${hidden} output lines hidden · ctrl+o to expand`), 4);
      for (const ol of shown) for (const wl of wrapText(ol, wrapW)) mk(dim(wl), 4);
    }

    rows.push({ plain: "", thread: "", kind: "blank", seg });
  });

  // Thread pass: the last content line of every segment gets └ so the line
  // closes on the answer; trailing blank rows stay un-guttered.
  const lastContent = new Map<number, number>();
  rows.forEach((r, i) => {
    if (r.kind === "content" && stripAnsi(r.plain).trim() !== "") lastContent.set(r.seg, i);
  });
  return rows.map((r, i) => {
    if (r.seg < 0 || r.kind === "block") return r.plain;
    const last = lastContent.get(r.seg);
    if (last === undefined || i > last) return r.plain;
    if (r.kind === "blank") return dim("  │");
    return (i === last ? "  └ " : "  │ ") + r.thread;
  });
}
