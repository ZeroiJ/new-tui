import { tint } from "./theme";

/** Word-wrap that preserves explicit newlines. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= width) {
      lines.push(raw);
      continue;
    }
    let cur = "";
    for (const word of raw.split(" ")) {
      if ((cur + " " + word).trim().length > width) {
        if (cur) lines.push(cur);
        if (word.length > width) {
          for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
          cur = "";
        } else cur = word;
      } else cur = cur ? cur + " " + word : word;
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** `code` spans in assistant prose, rendered as a tinted block like cursor. */
export function inlineCode(t: string): string {
  return t.replace(/`([^`\n]+)`/g, (_m, c: string) => tint(c));
}

/** Elapsed timer: 0ms → 35s → 1m35s */
export function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

/** Wall-clock age: 4s → 12m → 3h → 2d → (older) Mar 4 */
export function relTime(epochMs: number, now = Date.now()): string {
  if (!epochMs) return "—";
  const sec = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
