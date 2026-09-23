// Terminal key decoding: raw byte stream → semantic keys.

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
  | { kind: "unknown" };

const CTRL: Record<string, string> = {
  "\x03": "c", // ctrl+c
  "\x0c": "l", // ctrl+l clear
  "\x0f": "o", // ctrl+o expand tool output
  "\x07": "g", // ctrl+g editor
  "\x12": "r", // ctrl+r diff
  "\x15": "u", // ctrl+u clear input
  "\x01": "a",
  "\x02": "b",
  "\x05": "e",
  "\x06": "f",
  "\x0b": "k",
  "\x04": "d",
};

/**
 * Terminals can split one escape sequence across reads, which would leak
 * "[Z" into the prompt. Hold back a trailing partial sequence until the rest
 * arrives (the caller flushes it after a short timeout if nothing follows).
 */
export function takeIncompleteEscape(data: string): { ready: string; pending: string } {
  const i = data.lastIndexOf("\x1b");
  if (i < 0) return { ready: data, pending: "" };
  const tail = data.slice(i);
  const complete =
    /^\x1b\[[0-9;?]*[A-Za-z~]$/.test(tail) || /^\x1b(\r|\n)$/.test(tail) || tail === "\x1b[13;2u";
  if (complete || tail.length >= 8) return { ready: data, pending: "" };
  return { ready: data.slice(0, i), pending: tail };
}

export function* splitKeys(data: string): Generator<Key> {
  const chars = Array.from(data);
  let i = 0;
  const rest = () => chars.slice(i).join("");
  while (i < chars.length) {
    const r = rest();
    if (r.startsWith("\x1b[13;2u")) { i += Array.from("\x1b[13;2u").length; yield { kind: "enter", shift: true }; continue; }
    if (r.startsWith("\x1b\r") || r.startsWith("\x1b\n")) { i += 2; yield { kind: "enter", shift: true }; continue; }
    if (r.startsWith("\x1b[3~")) { i += 4; yield { kind: "delete" }; continue; }
    if (r.startsWith("\x1b[Z")) { i += 3; yield { kind: "tab", shift: true }; continue; }
    if (r.startsWith("\x1b[A")) { i += 3; yield { kind: "up" }; continue; }
    if (r.startsWith("\x1b[B")) { i += 3; yield { kind: "down" }; continue; }
    if (r.startsWith("\x1b[C")) { i += 3; yield { kind: "right" }; continue; }
    if (r.startsWith("\x1b[D")) { i += 3; yield { kind: "left" }; continue; }
    const ch = chars[i];
    if (ch === "\r" || ch === "\n") { i++; yield { kind: "enter", shift: false }; continue; }
    if (ch === "\t") { i++; yield { kind: "tab", shift: false }; continue; }
    if (ch === "\x7f" || ch === "\b") { i++; yield { kind: "backspace" }; continue; }
    if (ch === "\x1b") {
      // lone ESC (or alt+char handled as ESC + char pair)
      if (i + 1 < chars.length && chars[i + 1] !== "\x1b") {
        i++;
        continue;
      }
      i++;
      yield { kind: "esc" };
      continue;
    }
    const ctrl = CTRL[ch];
    if (ctrl) { i++; yield { kind: "ctrl", key: ctrl }; continue; }
    i++;
    yield { kind: "char", ch };
  }
}

export function parseKey(data: Buffer): Key {
  const s = data.toString("utf8");
  if (s === "\r" || s === "\n") return { kind: "enter", shift: false };
  if (s === "\x1b\r" || s === "\x1b\n") return { kind: "enter", shift: true };
  if (s === "\x1b[13;2u") return { kind: "enter", shift: true }; // kitty shift-enter
  if (CTRL[s]) return { kind: "ctrl", key: CTRL[s] };
  if (s === "\x1b") return { kind: "esc" };
  if (s === "\x7f" || s === "\x08") return { kind: "backspace" };
  if (s === "\x1b[3~") return { kind: "delete" };
  if (s === "\x09") return { kind: "tab", shift: false };
  if (s === "\x1b[Z") return { kind: "tab", shift: true };
  if (s === "\x1b[A") return { kind: "up" };
  if (s === "\x1b[B") return { kind: "down" };
  if (s === "\x1b[C") return { kind: "right" };
  if (s === "\x1b[D") return { kind: "left" };
  if (s.length === 1) return { kind: "char", ch: s };
  if (s.startsWith("\x1b") && s.length === 2) return { kind: "char", ch: s[1] };
  return { kind: "unknown" };
}
