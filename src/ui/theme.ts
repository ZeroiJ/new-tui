// Terminal theme: escape sequences and the small colour vocabulary the
// cursor-agent look is built from. Everything visual funnels through here.

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  invert: "\x1b[7m",
  noInvert: "\x1b[27m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  altOn: "\x1b[?1049h",
  altOff: "\x1b[?1049l",
  clear: "\x1b[2J\x1b[H",
};

/** Input-box surface: dark charcoal fill. */
const BOX_BG = [52, 52, 52] as const;
export function boxBg(s: string): string {
  return `\x1b[48;2;${BOX_BG[0]};${BOX_BG[1]};${BOX_BG[2]}m${s}\x1b[49m`;
}

/** User-prompt block: full-bleed dark surface, one step below the input box. */
const BLOCK_BG = [36, 36, 40] as const;
export function userBlockRow(s: string, width: number): string {
  return `\x1b[48;2;${BLOCK_BG[0]};${BLOCK_BG[1]};${BLOCK_BG[2]}m${s.padEnd(width)}\x1b[49m`;
}

export function dim(s: string): string {
  return `${ANSI.dim}${s}${ANSI.reset}`;
}

/**
 * Dim without a full reset — required inside the input box, where a reset
 * would drop the background for the rest of the row.
 */
export function softDim(s: string): string {
  return `${ANSI.dim}${s}\x1b[22m`;
}

export function bold(s: string): string {
  return `${ANSI.bold}${s}${ANSI.reset}`;
}

export function green(s: string): string {
  return `\x1b[32m${s}\x1b[39m`;
}

export function red(s: string): string {
  return `\x1b[31m${s}${ANSI.reset}`;
}

export function cyan(s: string): string {
  return `\x1b[36m${s}${ANSI.reset}`;
}

/** Inline `code` in assistant answers, tinted like cursor-agent. */
export function tint(s: string): string {
  return `\x1b[38;2;168;181;230m${s}\x1b[39m`;
}

export function shortCwd(cwd: string): string {
  const home = process.env.HOME ?? "";
  if (home && (cwd === home || cwd.startsWith(home + "/"))) return "~" + cwd.slice(home.length);
  return cwd;
}
