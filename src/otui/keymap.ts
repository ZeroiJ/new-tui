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
 *
 * Returns the keymap plus a setPopupActive toggle for the popup navigation
 * layer. Both enter/tab semantic commands read the real event's shift flag, so
 * behaviour is correct whether or not the matcher treats a bare "return" as
 * matching shifted returns.
 */
export function installKeymap(renderer: CliRenderer, onKey: OnKey): InstalledKeymap {
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
      { name: "app.copySession", run: forward({ kind: "copy" }) },
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
      { key: "ctrl+y", cmd: "app.copySession" },
    ],
  });

  // A second, higher-priority layer models "a popup owns navigation while it
  // is open". It binds only the keys a popup needs (nav + commit + dismiss);
  // every other key (notably printable characters, which drive the live filter
  // in the composer) falls through to the global layer / focused editor. The
  // layer's `enabled` predicate reads a mutable flag via setPopupActive, so it
  // activates/deactivates dynamically without re-registering.
  let popupOpen = false;
  keymap.registerLayer({
    priority: 10,
    enabled: () => popupOpen,
    commands: [
      { name: "popup.navigateUp", run: forward({ kind: "up" }) },
      { name: "popup.navigateDown", run: forward({ kind: "down" }) },
      { name: "popup.commit", run: forwardEnter },
      { name: "popup.dismiss", run: forward({ kind: "esc" }) },
    ],
    bindings: [
      { key: "up", cmd: "popup.navigateUp" },
      { key: "down", cmd: "popup.navigateDown" },
      { key: "return", cmd: "popup.commit" },
      { key: "shift+return", cmd: "popup.commit" },
      { key: "escape", cmd: "popup.dismiss" },
    ],
  });

  return {
    keymap,
    setPopupActive(active: boolean) {
      popupOpen = active;
    },
  };
}

export interface InstalledKeymap {
  keymap: Keymap<Renderable, KeyEvent>;
  setPopupActive: (active: boolean) => void;
}
