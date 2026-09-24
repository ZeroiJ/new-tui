// The semantic key shape the application controller handles. Produced by the
// OpenTUI keymap (src/otui/keymap.ts) and the test mock; the raw terminal
// decoding that used to live in ui/keys.ts is gone — the OpenTUI keyInput
// parser owns escape-sequence handling now.

export type Key =
  | { kind: "char"; ch: string }
  | { kind: "enter"; shift: boolean }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "esc" }
  | { kind: "tab"; shift: boolean }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "ctrl"; key: string }
  | { kind: "copy" }
  | { kind: "unknown" };
