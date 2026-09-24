// The OpenTUI shell: a real renderable tree that mirrors what src/ui/render.ts
// assembles as a string, driven by the same UIState.
//
// Why the bridge: our row builders in src/ui/* already produce the exact
// cursor-agent look, and OpenTUI renders its own styled-text chunks rather
// than ANSI. So the transcript/status/meta/popup keep their current builders
// and their output is translated to styled text; only the frame engine, the
// composer and the input path change. Porting those builders to native chunks
// is a later phase and needs no behaviour change here.

import {
  BoxRenderable,
  DiffRenderable,
  RGBA,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
  type Renderable,
} from "@opentui/core";
import type { InstalledKeymap } from "./keymap";

import { ansiToStyled, ansiRowsToStyled } from "./ansi";
import { installKeymap } from "./keymap";
import { TranscriptView } from "./transcript";
import { modelPopup, sessionsPopup, slashPopup } from "../ui/popups";
import { hintsRows, statusRows } from "../ui/status";
import { metaRows } from "../ui/composer";
import { diffOverlay, permissionRows } from "../ui/overlays";
import { TIPS } from "../tips";
import type { UIState } from "../state";
import type { Key } from "../ui/keys";

/** Composer surface, matching theme.ts BOX_BG (52,52,52). */
const BOX_BG = RGBA.fromInts(52, 52, 52);
const ACCENT = RGBA.fromInts(168, 181, 230);

/** Best-effort tree-sitter filetype from a path's extension (for diff/code highlighting). */
function filetypeFor(file: string): string | undefined {
  const ext = file.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    mts: "typescript", cts: "typescript", mjs: "javascript", cjs: "javascript",
    md: "markdown", zig: "zig",
  };
  return map[ext];
}

/** Translate an OpenTUI key event into the Key shape the app already handles. */
export function mapKey(key: KeyEvent): Key | null {
  const shift = !!key.shift;
  switch (key.name) {
    case "up": return { kind: "up" };
    case "down": return { kind: "down" };
    case "left": return { kind: "left" };
    case "right": return { kind: "right" };
    case "return": return { kind: "enter", shift };
    case "tab": return { kind: "tab", shift };
    case "escape": return { kind: "esc" };
    case "backspace": return { kind: "backspace" };
    case "delete": return { kind: "delete" };
  }
  if (key.ctrl && key.name.length === 1) return { kind: "ctrl", key: key.name };
  const seq = key.sequence ?? "";
  if (seq && [...seq].length === 1) return { kind: "char", ch: seq };
  return null;
}

export interface ShellCallbacks {
  /** a control key the app should handle */
  onKey: (key: Key) => void | Promise<void>;
  /** the composer text or cursor changed */
  onEdit: () => void;
}

export class OtuiShell {
  private constructor(
    private renderer: CliRenderer,
    private cb: ShellCallbacks,
  ) {}

  static async create(cb: ShellCallbacks, existing?: CliRenderer): Promise<OtuiShell> {
    const renderer =
      existing ??
      (await createCliRenderer({
        // ctrl+c is the interrupt/quit key in the cursor-agent look, never exit
        exitOnCtrlC: false,
        backgroundColor: "#000000",
        screenMode: "alternate-screen",
      }));
    const shell = new OtuiShell(renderer, cb);
    shell.build();
    return shell;
  }

  // ----- tree --------------------------------------------------------------

  private head!: TextRenderable;
  private scroll!: ScrollBoxRenderable;
  private transcriptView!: TranscriptView;
  private popup!: TextRenderable;
  private hints!: TextRenderable;
  private status!: TextRenderable;
  private composerRow!: BoxRenderable;
  private input!: TextareaRenderable;
  private hintText!: TextRenderable;
  private meta!: TextRenderable;
  private extra!: TextRenderable;
  private overlay!: BoxRenderable;
  private overlayScroll!: ScrollBoxRenderable;

  private lastInput = "";
  private lastRows = 0;
  private lastCols = 0;
  private suppressEdit = false;
  private keymap: InstalledKeymap | null = null;

  private build() {
    const r = this.renderer;
    const text = (id: string, content = "") =>
      new TextRenderable(r, { id, content, wrapMode: "none", selectable: false });

    this.head = text("head");
    this.scroll = new ScrollBoxRenderable(r, {
      id: "transcript",
      width: "100%",
      height: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      scrollY: true,
      scrollX: false,
      viewportCulling: true,
      verticalScrollbarOptions: { visible: false },
    });
    this.transcriptView = new TranscriptView(r, this.scroll);
    this.popup = text("popup");
    this.hints = text("hints");
    this.status = text("status");

    this.input = new TextareaRenderable(r, {
      id: "composer",
      flexGrow: 1,
      height: 1,
      placeholder: "",
      backgroundColor: RGBA.fromValues(0, 0, 0, 0),
      focusedBackgroundColor: RGBA.fromValues(0, 0, 0, 0),
      textColor: RGBA.fromInts(255, 255, 255),
      focusedTextColor: RGBA.fromInts(255, 255, 255),
      cursorStyle: { style: "block", blinking: false, color: ACCENT },
      wrapMode: "none",
      onContentChange: () => {
        if (this.suppressEdit) return;
        this.cb.onEdit();
      },
      onCursorChange: () => {
        if (this.suppressEdit) return;
        this.cb.onEdit();
      },
    });

    this.hintText = text("composerHint");
    this.composerRow = new BoxRenderable(r, {
      id: "composerRow",
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: BOX_BG,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.composerRow.add(text("composerArrow", "→"));
    this.composerRow.add(this.input);
    this.composerRow.add(this.hintText);

    this.meta = text("meta");
    this.extra = text("extra");

    // Full-screen diff overlay: per-file DiffRenderables in a scrollable stack.
    this.overlay = new BoxRenderable(r, {
      id: "overlay",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: RGBA.fromHex("#0d0d0f"),
      visible: false,
    });
    this.overlayScroll = new ScrollBoxRenderable(r, {
      id: "overlayScroll",
      width: "100%",
      height: "100%",
      scrollY: true,
      verticalScrollbarOptions: { visible: false },
    });
    this.overlay.add(this.overlayScroll);

    r.root.add(this.head);
    r.root.add(this.scroll);
    r.root.add(this.popup);
    r.root.add(this.hints);
    r.root.add(this.status);
    r.root.add(this.composerRow);
    r.root.add(this.meta);
    r.root.add(this.extra);
    r.root.add(this.overlay);

    this.input.focus();

    // Workstream #1: keymap owns the control keys. The host prepends its
    // listener, and matched bindings preventDefault+stopPropagation, so
    // consumed control keys never reach the focused editor; printable keys
    // pass through to it, and its callbacks mirror edits back into state.
    this.keymap = installKeymap(r, this.cb.onKey);

    r.keyInput.on("paste", (event: PasteEvent) => {
      // bracketed paste is terminal input; let the focused editor take it
      if (event.bytes.length) this.cb.onEdit();
    });
    r.on("resize", () => this.cb.onEdit());
  }

  // ----- state → tree ------------------------------------------------------

  /** Push the whole UIState into the tree. Cheap when nothing changed. */
  sync(s: UIState) {
    const r = this.renderer;
    if (s.diffOpen) {
      this.overlay.visible = true;
      this.syncDiff(s);
      return;
    }
    if (this.overlay.visible) this.overlay.visible = false;

    // header — same three lines + spacer as the ANSI frame
    this.head.content = ansiToStyled(
      ["  Opencode", `  v${s.version}`, `  ${TIPS[s.tipIndex % TIPS.length]}`, ""].join("\n"),
    );

    // popups
    const popupRows = s.modelOpen
      ? modelPopup(s)
      : s.sessionsOpen
        ? sessionsPopup(s)
        : s.slashOpen
          ? slashPopup(s)
          : [];
    this.popup.content = popupRows.length ? ansiRowsToStyled(popupRows) : "";
    // popup nav layer is active only while a picker is open
    this.keymap?.setPopupActive(popupRows.length > 0);

    this.hints.content = ansiRowsToStyled(hintsRows(s));
    this.status.content = ansiRowsToStyled(statusRows(s, Date.now()));
    this.meta.content = ansiRowsToStyled(metaRows(s));

    // below-box lines: tasks, permission, transient status
    const extra: string[] = [];
    if (s.taskCount > 0) extra.push(`  ${s.taskCount} task${s.taskCount === 1 ? "" : "s"}`);
    if (s.permission) extra.push(...permissionRows(s));
    else if (s.statusMsg) extra.push(`  ${s.statusMsg}`);
    this.extra.content = ansiRowsToStyled(extra);

    // composer: text and cursor are owned by the Textarea, mirrored into state
    this.syncComposer(s);

    // transcript: per-item renderables (assistant = Markdown) inside the
    // ScrollBox, which hugs its content up to the available height.
    this.transcriptView.sync(s);
    const headH = 4;
    const tailH =
      popupRows.length + hintsRows(s).length + statusRows(s, Date.now()).length +
      1 + metaRows(s).length + extra.length;
    const avail = Math.max(3, s.rows - headH - tailH - 1);
    // The transcript hugs its content up to the available height. scrollHeight
    // is the measured content height (dynamic for Markdown), so numeric height
    // = min(content, avail) reproduces the top-anchored frame; the 120ms tick
    // re-measures, so a Markdown block that grows settles on the next frame.
    const contentH = this.scroll.scrollHeight;
    const wanted = Math.max(1, Math.min(Math.max(1, contentH), avail));
    if (wanted !== this.lastRows || s.cols !== this.lastCols) {
      this.scroll.height = wanted;
      this.lastRows = wanted;
      this.lastCols = s.cols;
    }
    // scrollOffset counts lines up from the bottom, like the ANSI frame
    if (s.scrollOffset > 0) {
      const maxTop = Math.max(0, contentH - wanted);
      this.scroll.scrollTop = Math.max(0, maxTop - s.scrollOffset);
    } else {
      this.scroll.scrollTo(this.scroll.scrollHeight);
    }
    void r;
  }

  /** Reconcile per-file DiffRenderables in the overlay for the current diff. */
  private syncDiff(s: UIState) {
    const files = s.diffFiles;
    // drop stale per-file views
    while (this.diffViews.length > files.length) {
      const v = this.diffViews.pop();
      if (v) this.overlayScroll.remove(v.root);
    }
    for (let i = 0; i < files.length; i++) {
      const d = files[i];
      let v = this.diffViews[i];
      if (!v) {
        const root = new BoxRenderable(this.renderer, { id: `diff-${i}`, width: "100%", flexDirection: "column" });
        const header = new TextRenderable(this.renderer, {
          content: `  ${d.file}  (${d.status} +${d.additions} -${d.deletions})`,
          fg: RGBA.fromInts(168, 181, 230),
        });
        const view = new DiffRenderable(this.renderer, {
          width: "100%",
          diff: d.patch,
          view: "unified",
          filetype: filetypeFor(d.file),
          showLineNumbers: true,
          addedBg: RGBA.fromHex("#12351f"),
          removedBg: RGBA.fromHex("#3a1a1a"),
          addedSignColor: RGBA.fromHex("#22c55e"),
          removedSignColor: RGBA.fromHex("#ef4444"),
        });
        root.add(header);
        root.add(view);
        v = { sig: "", root };
        this.diffViews[i] = v;
        this.overlayScroll.add(v.root);
        continue;
      }
      const sig = `${d.file}\u0001${d.patch.length}\u0001${d.additions}\u0001${d.deletions}`;
      if (v.sig === sig) continue;
      const header = v.root.getChildren()[0] as TextRenderable;
      const view = v.root.getChildren()[1] as DiffRenderable;
      header.content = `  ${d.file}  (${d.status} +${d.additions} -${d.deletions})`;
      view.diff = d.patch;
      v.sig = sig;
    }
    if (files.length === 0 && !this.diffEmptyShown) {
      this.diffEmptyShown = true;
      const t = new TextRenderable(this.renderer, { content: "  (no changes)", fg: RGBA.fromInts(140, 140, 140) });
      this.overlayScroll.add(t);
    } else if (files.length > 0 && this.diffEmptyShown) {
      this.diffEmptyShown = false;
      // remove the "(no changes)" placeholder if present
      const kids = this.overlayScroll.getChildren();
      for (const k of kids) {
        if (k instanceof TextRenderable) this.overlayScroll.remove(k);
      }
    }
    this.overlayScroll.scrollTop = s.diffScroll;
  }

  private diffViews: { sig: string; root: BoxRenderable }[] = [];
  private diffEmptyShown = false;

  private syncComposer(s: UIState) {
    const lines = s.input.split("\n").length;
    this.composerRow.height = Math.max(1, lines);
    this.input.height = Math.max(1, lines);

    const hint = s.streaming ? " ctrl+c to stop" : "";
    this.hintText.content = hint ? ansiToStyled(`\x1b[2m${hint}\x1b[0m`) : "";

    if (s.input !== this.lastInput || this.input.plainText !== s.input) {
      this.suppressEdit = true;
      this.input.setText(s.input);
      const pos = this.posFromIndex(s.input, Math.min(s.cursor, s.input.length));
      this.input.setCursor(pos.row, pos.col);
      this.suppressEdit = false;
      this.lastInput = s.input;
    }
    // placeholder rides along as the first line's text when the box is empty
    if (!s.input && this.input.plainText === "") {
      this.suppressEdit = true;
      this.input.placeholder = s.followUp ? "Add a follow-up" : "Plan, search, build anything";
      this.suppressEdit = false;
    }
  }

  private posFromIndex(text: string, index: number): { row: number; col: number } {
    let row = 0;
    let col = 0;
    for (let i = 0; i < index; i++) {
      if (text[i] === "\n") {
        row++;
        col = 0;
      } else col++;
    }
    return { row, col };
  }

  /** Mirror the editor back into state (called by the app on edit). */
  readComposer(): { input: string; cursor: number } {
    return { input: this.input.plainText, cursor: this.input.cursorOffset };
  }

  get size() {
    return { cols: this.renderer.terminalWidth, rows: this.renderer.terminalHeight };
  }

  /** Copy text to the system clipboard via OSC 52 (works over SSH). */
  copyToClipboard(text: string): boolean {
    return this.renderer.copyToClipboardOSC52(text);
  }

  /** Fire a desktop notification (best effort). */
  notify(title: string, message: string): boolean {
    return this.renderer.triggerNotification(message, title);
  }

  /** Release the terminal (external editor), then come back. */
  suspend() {
    this.renderer.destroy();
  }

  async resume(cb: ShellCallbacks) {
    this.cb = cb;
    this.renderer = await createCliRenderer({
      exitOnCtrlC: false,
      backgroundColor: "#000000",
      screenMode: "alternate-screen",
    });
    this.build();
  }

  destroy() {
    this.renderer.destroy();
  }
}
