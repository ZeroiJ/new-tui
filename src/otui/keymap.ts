// Workstream #1: declarative key dispatch via @opentui/keymap.
//
// A global layer owns the control keys (arrows, ctrl+*, Tab, Esc, Enter) and
// routes each one to the app's existing handleKey(Key) contract. Printable
// characters deliberately have NO binding: keymap ignores them, the event
// falls through to the focused Textarea, and the editor's content/cursor
// callbacks mirror the edit back into state — the editor keeps owning plain
// typing, exactly as before.
//
// Focus-scoped layers for the Select-based pickers (workstream #2) will hang
// off the same keymap, and getCommands()/getActiveKeys() expose the live
// command list so the `?` hints panel can be generated instead of hand-written.
//
// Robustness: the enter/tab commands inspect the real event's `shift` rather
// than assuming which binding matched, so behaviour is correct whether the
// matcher treats a bare "return" as matching shifted returns or not.

import type { Keymap } from "@opentui/keymap";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { Key } from "../ui/keys";

export type OnKey = (key: Key) => void | Promise<void>;

/**
 * Install the global control-key layer on a fresh keymap bound to `renderer`.
 * The keymap's host uses prependListener and matched bindings
 * preventDefault+stopPropagation, so consumed control keys never reach the
 * focused editor, and printable keys pass straight through to it.
 */
export function installKeymap(renderer: CliRenderer, onKey: OnKey): Keymap<Renderable, KeyEvent> {
  const keymap = createDefaultOpenTuiKeymap(renderer);
  const forward = (key: Key) => () => {
    void onKey(key);
  };
  const forwardEnter = (ctx: { event: KeyEvent }) => {
    void onKey({ kind: "enter", shift: !!ctx.event.shift });
  };
  const forwardTab = (ctx: { event: KeyEvent }) => {
    void onKey({ kind: "tab", shift: !!ctx.event.shift });
  };

  keymap.registerLayer({
    priority: 0,
    commands: [
      { name: "app.navigateUp", run: forward({ kind: "up" }) },
      { name: "app.navigateDown", run: forward({ kind: "down" }) },
      { name: "app.escape", run: forward({ kind: "esc" }) },
      { name: "app.submitOrNewline", run: forwardEnter },
      { name: "app.completeOrModeCycle", run: forwardTab },
      { name: "app.interrupt", run: forward({ kind: "ctrl", key: "c" }) },
      { name: "app.clearScreen", run: forward({ kind: "ctrl", key: "l" }) },
      { name: "app.toggleOutput", run: forward({ kind: "ctrl", key: "o" }) },
      { name: "app.openEditor", run: forward({ kind: "ctrl", key: "g" }) },
      { name: "app.openDiff", run: forward({ kind: "ctrl", key: "r" }) },
      { name: "app.clearInput", run: forward({ kind: "ctrl", key: "u" }) },
      { name: "app.quit", run: forward({ kind: "ctrl", key: "d" }) },
    ],
    bindings: [
      { key: "up", cmd: "app.navigateUp" },
      { key: "down", cmd: "app.navigateDown" },
      { key: "escape", cmd: "app.escape" },
      { key: "return", cmd: "app.submitOrNewline" },
      { key: "shift+return", cmd: "app.submitOrNewline" },
      { key: "tab", cmd: "app.completeOrModeCycle" },
      { key: "shift+tab", cmd: "app.completeOrModeCycle" },
      { key: "ctrl+c", cmd: "app.interrupt" },
      { key: "ctrl+l", cmd: "app.clearScreen" },
      { key: "ctrl+o", cmd: "app.toggleOutput" },
      { key: "ctrl+g", cmd: "app.openEditor" },
      { key: "ctrl+r", cmd: "app.openDiff" },
      { key: "ctrl+u", cmd: "app.clearInput" },
      { key: "ctrl+d", cmd: "app.quit" },
    ],
  });

  return keymap;
}
