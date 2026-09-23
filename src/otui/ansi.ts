// ANSI → OpenTUI styled text.
//
// The cursor-agent look is produced by our existing row builders in src/ui/*,
// which emit SGR escape strings. OpenTUI's TextRenderable does not parse ANSI
// — it renders its own styled-text chunks. This translator is the bridge
// between the two so the whole existing visual layer keeps working unchanged
// while the frame engine moves underneath it.
//
// Only the SGR subset our theme actually emits is handled:
//   reset, bold, dim, italic, underline, inverse, fg/bg 16-colour,
//   fg/bg truecolor, and the "off" forms (22/27/39/49).

import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core";

interface Style {
  fg?: RGBA;
  bg?: RGBA;
  attrs: number;
}

const BASIC: Record<number, string> = {
  30: "#000000", 31: "#cd3131", 32: "#0dbc79", 33: "#b58900",
  34: "#2472c8", 35: "#bc3fbc", 36: "#11a8cd", 37: "#c5c5c5",
  90: "#666666", 91: "#f14c4c", 92: "#23d18b", 93: "#f5f543",
  94: "#3b8eea", 95: "#d670d6", 96: "#29b8db", 97: "#ffffff",
};

function applyCode(style: Style, code: number): void {
  if (code === 0) {
    style.fg = undefined;
    style.bg = undefined;
    style.attrs = TextAttributes.NONE;
    return;
  }
  if (code === 1) style.attrs |= TextAttributes.BOLD;
  else if (code === 2) style.attrs |= TextAttributes.DIM;
  else if (code === 3) style.attrs |= TextAttributes.ITALIC;
  else if (code === 4) style.attrs |= TextAttributes.UNDERLINE;
  else if (code === 5) style.attrs |= TextAttributes.BLINK;
  else if (code === 7) style.attrs |= TextAttributes.INVERSE;
  else if (code === 22) style.attrs &= ~TextAttributes.DIM;
  else if (code === 23) style.attrs &= ~TextAttributes.ITALIC;
  else if (code === 24) style.attrs &= ~TextAttributes.UNDERLINE;
  else if (code === 27) style.attrs &= ~TextAttributes.INVERSE;
  else if (code === 39) style.fg = undefined;
  else if (code === 49) style.bg = undefined;
  else if (BASIC[code]) style.fg = RGBA.fromHex(BASIC[code]);
  else if (code >= 40 && code <= 47) style.bg = RGBA.fromHex(BASIC[code - 10]);
  else if (code >= 100 && code <= 107) style.bg = RGBA.fromHex(BASIC[code - 10]);
}

/** Convert one ANSI-styled string into renderable styled text. */
export function ansiToStyled(input: string): StyledText {
  const style: Style = { attrs: TextAttributes.NONE };
  const chunks: TextChunk[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (!buffer) return;
    const chunk: TextChunk = { __isChunk: true, text: buffer };
    const last = chunks[chunks.length - 1];
    // merge into the previous chunk when the style did not change
    if (last && chunkStyleEq(last, style)) {
      last.text += buffer;
    } else {
      if (style.fg) chunk.fg = style.fg;
      if (style.bg) chunk.bg = style.bg;
      if (style.attrs) chunk.attributes = style.attrs;
      chunks.push(chunk);
    }
    buffer = "";
  };

  while (i < input.length) {
    if (input[i] === "\x1b" && input[i + 1] === "[") {
      const end = input.indexOf("m", i + 2);
      if (end === -1) {
        // not an SGR we understand — keep the bytes as literal text
        buffer += input[i];
        i++;
        continue;
      }
      flush();
      const codes = input
        .slice(i + 2, end)
        .split(";")
        .filter((c) => c !== "")
        .map((c) => Number(c));
      const params = codes.length ? codes : [0];
      for (let p = 0; p < params.length; p++) {
        const c = params[p];
        // truecolor: 38;2;r;g;b (and 48;2;r;g;b for background)
        if ((c === 38 || c === 48) && params[p + 1] === 2) {
          const [r, g, b] = [params[p + 2] ?? 0, params[p + 3] ?? 0, params[p + 4] ?? 0];
          const color = RGBA.fromInts(r, g, b);
          if (c === 38) style.fg = color;
          else style.bg = color;
          p += 4;
          continue;
        }
        applyCode(style, c);
      }
      i = end + 1;
      continue;
    }
    buffer += input[i];
    i++;
  }
  flush();
  return new StyledText(chunks);
}

function chunkStyleEq(chunk: TextChunk, style: Style): boolean {
  if ((chunk.attributes ?? 0) !== style.attrs) return false;
  if (String(chunk.fg ?? "") !== String(style.fg ?? "")) return false;
  if (String(chunk.bg ?? "") !== String(style.bg ?? "")) return false;
  return true;
}

/** Convert an array of ANSI row strings (one per line). */
export function ansiRowsToStyled(rows: string[]): StyledText {
  return ansiToStyled(rows.join("\n"));
}
