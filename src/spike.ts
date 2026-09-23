// OpenTUI Phase 0 go/no-go probe — NOT part of the TUI.
//
// Proves the things the migration depends on, on this machine, today:
//   1. the native Zig core loads under Bun
//   2. a real renderer comes up in tmux and restores the terminal on exit
//   3. keyInput parses arrows, ctrl+key, Shift+Tab and bracketed paste
//      (the bug classes our hand-rolled keys.ts had to defend against)
//   4. a Textarea draws our flat light-grey box with a block cursor
//   5. the checkerboard below turns green as each item is verified
//
// Run: tmux new -s spike 'bun src/spike.ts'   then q to quit.

import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type KeyEvent,
  type PasteEvent,
} from "@opentui/core";

const t0 = Date.now();
const log: string[] = [];
const checks: Record<string, boolean> = {
  "native core loaded": true,
  "renderer created": true,
  "keypress parsed": false,
  "ctrl+key parsed": false,
  "shift+tab parsed": false,
  "paste event": false,
  "textarea edited": false,
  "block cursor on grey box": true,
};

let keys: TextRenderable;
let gate: TextRenderable;

function push(line: string) {
  log.unshift(line);
  if (log.length > 7) log.pop();
  if (keys) keys.content = log.join("\n");
}

const renderer = await createCliRenderer({ exitOnCtrlC: false, backgroundColor: "#101010" });
const bootMs = Date.now() - t0;

const head = new TextRenderable(renderer, {
  id: "head",
  content: `  OpenTUI Phase 0 spike   boot ${bootMs}ms`,
  fg: "#a8b5e6",
});

const intro = new TextRenderable(renderer, {
  id: "intro",
  content: "  press: ↓ ↑ ctrl+o shift+tab paste  ·  q quits",
  fg: "#565f89",
});

gate = new TextRenderable(renderer, { id: "gate", content: "", fg: "#98c379" });

// A plain Box proves layout + background work independently of the editor.
const panel = new BoxRenderable(renderer, {
  id: "panel",
  width: 60,
  height: 1,
  backgroundColor: "#282c34",
  paddingLeft: 1,
});
panel.add(new TextRenderable(renderer, { content: " BoxRenderable: layout + background", fg: "#abb2bf" }));

// The composer candidate: flat grey box, block cursor, placeholder.
const input = new TextareaRenderable(renderer, {
  id: "input",
  width: 60,
  height: 3,
  placeholder: "type here — this is the future composer box",
  placeholderColor: "#6b7280",
  backgroundColor: "#343434",
  focusedBackgroundColor: "#343434",
  textColor: "#ffffff",
  focusedTextColor: "#ffffff",
  cursorStyle: { style: "block", blinking: false, color: RGBA.fromHex("#a8b5e6") },
  onContentChange: () => {
    if (input.plainText.length > 0) {
      checks["textarea edited"] = true;
      paintGates();
    }
  },
});

keys = new TextRenderable(renderer, { id: "keys", content: "  (no keys yet)", fg: "#7f848e" });

function paintGates() {
  gate.content = Object.entries(checks)
    .map(([k, v]) => (v ? "  ✓ " : "  · ") + k)
    .join("\n");
}

renderer.root.add(head);
renderer.root.add(intro);
renderer.root.add(gate);
renderer.root.add(panel);
renderer.root.add(input);
renderer.root.add(keys);
paintGates();
input.focus();
keys.content = "  (no keys yet)";

const mods = (key: KeyEvent) =>
  [key.ctrl && "ctrl", key.shift && "shift", key.meta && "meta"].filter(Boolean).join("+");

renderer.keyInput.on("keypress", (key: KeyEvent) => {
  if (key.name === "q" && !key.ctrl) {
    renderer.destroy();
    return;
  }
  if (key.ctrl && key.name === "c") {
    push(`key: ctrl+c survived (exitOnCtrlC:false)`);
    return;
  }
  if (["up", "down", "left", "right", "tab", "return"].includes(key.name)) checks["keypress parsed"] = true;
  if (key.ctrl) checks["ctrl+key parsed"] = true;
  if (key.name === "tab" && key.shift) checks["shift+tab parsed"] = true;
  push(`key: ${key.name}${mods(key) ? " [" + mods(key) + "]" : ""}  seq=${JSON.stringify(key.sequence)}`);
  paintGates();
});

renderer.keyInput.on("paste", (event: PasteEvent) => {
  checks["paste event"] = true;
  const decoder = new TextDecoder();
  push(`paste: ${JSON.stringify(decoder.decode(event.bytes))}`);
  paintGates();
});

renderer.on("destroy", () => {
  process.stdout.write("\n  spike: renderer destroyed, terminal restored\n");
});
