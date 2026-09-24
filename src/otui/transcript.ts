// Per-item transcript view for the OpenTUI shell (migration workstream #3).
//
// The flat ANSI body is replaced by one renderable per transcript item inside
// the ScrollBox, so assistant messages can render as real Markdown while user
// blocks and tool lines keep the exact cursor-agent look.
//
// Layout trade-off (agreed): assistant messages are indented but do NOT carry
// the per-row │/└ thread gutter — Markdown's height is dynamic and no
// OpenTUI component exposes it synchronously, so an exact per-row gutter is not
// computable. Tool/system/error lines keep a gutter (their row count is known
// from our own wrapText) and close each block with └. User blocks, tool timers,
// and collapsible output are unchanged.

import {
  BoxRenderable,
  MarkdownRenderable,
  RGBA,
  SyntaxStyle,
  TextRenderable,
  type CliRenderer,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core";

import { ansiRowsToStyled } from "./ansi";
import { fmtDur, wrapText } from "../ui/text";
import { dim } from "../ui/theme";
import type { TranscriptItem, UIState } from "../state";

/** User-prompt block surface (matches theme.ts BLOCK_BG). */
const USER_BG = RGBA.fromInts(36, 36, 40);

/** Shared dark syntax theme for Markdown/Code/Diff highlighting. */
let SYNTAX: SyntaxStyle | null = null;
function syntax(): SyntaxStyle {
  if (!SYNTAX) {
    SYNTAX = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromInts(220, 223, 228) },
      keyword: { fg: RGBA.fromInts(255, 123, 114) },
      "keyword.operator": { fg: RGBA.fromInts(255, 166, 87) },
      string: { fg: RGBA.fromInts(165, 214, 255) },
      comment: { fg: RGBA.fromInts(125, 133, 144), italic: true },
      number: { fg: RGBA.fromInts(121, 192, 255) },
      boolean: { fg: RGBA.fromInts(121, 192, 255) },
      function: { fg: RGBA.fromInts(210, 168, 255) },
      type: { fg: RGBA.fromInts(255, 166, 87) },
      variable: { fg: RGBA.fromInts(220, 223, 228) },
      "variable.member": { fg: RGBA.fromInts(121, 192, 255) },
      property: { fg: RGBA.fromInts(121, 192, 255) },
      punctuation: { fg: RGBA.fromInts(180, 185, 195) },
      operator: { fg: RGBA.fromInts(255, 123, 114) },
      "markup.heading": { fg: RGBA.fromInts(88, 166, 255), bold: true },
      "markup.list": { fg: RGBA.fromInts(255, 123, 114) },
      "markup.quote": { fg: RGBA.fromInts(125, 133, 144), italic: true },
      "markup.raw": { fg: RGBA.fromInts(165, 214, 255) },
      "markup.link": { fg: RGBA.fromInts(88, 166, 255), underline: true },
    });
  }
  return SYNTAX;
}

function isShellLine(item: TranscriptItem): boolean {
  return item.role === "tool" && /^\s*(?:\u2717\s*)?\$\s/.test(item.text);
}

interface ItemView {
  sig: string;
  root: Renderable;
  md?: MarkdownRenderable;
  text?: TextRenderable;
}

export class TranscriptView {
  private views: ItemView[] = [];

  constructor(
    private renderer: CliRenderer,
    private scroll: ScrollBoxRenderable,
  ) {}

  /** Reconcile children with the current transcript. */
  sync(s: UIState) {
    const now = Date.now();
    const items = s.transcript;

    // drop views for removed items (transcript reset / fork)
    while (this.views.length > items.length) {
      const v = this.views.pop();
      if (v) this.scroll.remove(v.root);
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const live = item.role === "assistant" && s.streaming && i === s.liveAssistantIdx;
      const sig = this.signature(item, s, live, now);
      let v = this.views[i];
      if (!v) {
        v = this.create(item, s, live);
        this.views[i] = v;
        this.scroll.add(v.root);
        continue;
      }
      if (v.sig === sig) continue;
      this.update(v, item, s, live, now);
      v.sig = sig;
    }
  }

  private signature(item: TranscriptItem, s: UIState, live: boolean, now: number): string {
    let timer = "";
    if (item.role === "tool" && item.startedAt != null) {
      const ms = (item.endedAt ?? (s.streaming ? now : item.startedAt)) - item.startedAt;
      timer = fmtDur(ms);
    }
    return [item.role, item.text, timer, s.outputExpanded ? "x" : "-", item.output?.length ?? 0, live ? "L" : ""].join("\u0001");
  }

  private create(item: TranscriptItem, s: UIState, live: boolean): ItemView {
    const r = this.renderer;
    if (item.role === "user") {
      const root = new BoxRenderable(r, {
        id: `user-${this.views.length}`,
        width: "100%",
        flexDirection: "column",
        backgroundColor: USER_BG,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
      });
      const text = new TextRenderable(r, { content: this.userText(item, s), fg: RGBA.fromInts(235, 235, 238) });
      root.add(text);
      return { sig: "", root, text };
    }
    if (item.role === "assistant") {
      const root = new BoxRenderable(r, {
        id: `asst-${this.views.length}`,
        width: "100%",
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 1,
      });
      const md = new MarkdownRenderable(r, {
        width: "100%",
        content: item.text,
        syntaxStyle: syntax(),
        streaming: live,
        fg: RGBA.fromInts(220, 223, 228),
      });
      root.add(md);
      return { sig: "", root, md };
    }
    const text = new TextRenderable(r, { content: ansiRowsToStyled(this.toolRows(item, s, nowSafe())) });
    return { sig: "", root: text, text };
  }
  private update(v: ItemView, item: TranscriptItem, s: UIState, live: boolean, now: number) {
    if (v.md) {
      v.md.content = item.text;
      v.md.streaming = live;
      return;
    }
    if (v.text) {
      const content = item.role === "user" ? this.userText(item, s) : ansiRowsToStyled(this.toolRows(item, s, now));
      v.text.content = content as typeof v.text.content;
    }
  }

  private userText(item: TranscriptItem, s: UIState): string {
    return wrapText(item.text, Math.max(20, s.cols - 4)).join("\n");
  }

  /**
   * Tool/system/error rows with the thread gutter. These use our own wrapText,
   * so the row count (and therefore the gutter) is exact.
   */
  private toolRows(item: TranscriptItem, s: UIState, now: number): string[] {
    const W = s.cols;
    const shell = isShellLine(item);
    const indent = shell ? 1 : 4;
    const wrapW = Math.max(20, W - 6);
    const rows: string[] = [];
    const mk = (inner: string) => rows.push(" ".repeat(Math.max(0, indent - 2)) + inner);

    const color = (t: string) => (item.role === "error" ? `\x1b[31m${t}\x1b[0m` : dim(t));
    const lines = wrapText(item.text, wrapW);
    lines.forEach((ln, li) => {
      let inner = color(ln);
      if (item.role === "tool" && li === 0 && item.startedAt != null) {
        const ms = (item.endedAt ?? (s.streaming ? now : item.startedAt)) - item.startedAt;
        inner += ` ${dim(fmtDur(ms))}`;
      }
      mk(inner);
    });

    if (item.output && item.output.length > 0) {
      const shown = s.outputExpanded ? item.output : item.output.length > 2 ? item.output.slice(-2) : item.output;
      const hidden = item.output.length - shown.length;
      if (hidden > 0) mk(dim(`… ${hidden} output lines hidden · ctrl+o to expand`));
      for (const ol of shown) for (const wl of wrapText(ol, wrapW)) mk(dim(wl));
    }

    // gutter: │ on every row, └ on the last non-empty row
    const last = rows.reduce((acc, r, i) => (r.trim() ? i : acc), -1);
    return rows.map((r, i) => (i === last ? "  └ " : "  │ ") + r);
  }
}

function nowSafe(): number {
  return Date.now();
}
