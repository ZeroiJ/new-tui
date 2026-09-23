// Terminal reinterpretations of the loading.dev spinner designs
// (https://loading.dev — MIT © Jakub Krehel & Paul Faivret).
//
// The originals are React 19 components animated with CSS keyframes on SVG/DOM
// elements, so there is no frame data to lift into a terminal. These are ANSI
// ports of the same motion: the same cycle durations (from their
// `SPINNER_MOTION` table in src/motion.ts), expressed as single-line cell
// animations that fit the status line. Frames are pre-colored ANSI strings.

export interface Spinner {
  name: string;
  label: string;
  /** full cycle in ms — from loading.dev's SPINNER_MOTION */
  cycleMs: number;
  /** visible cell width */
  width: number;
  frames: string[];
}

// Brightness ramp: faint grey → dim green → green → bold green.
const LV = ["\x1b[90m", "\x1b[2;32m", "\x1b[32m", "\x1b[1;32m"] as const;
const R = "\x1b[0m";

const frame = (spec: Array<[string, number]>): string =>
  spec.map(([ch, lv]) => `${LV[lv]}${ch}${R}`).join("");

// --- LinearDots: three dots, staggered opacity sweep (900ms) ---------------
const linearDots = [
  [3, 2, 1],
  [1, 3, 2],
  [2, 1, 3],
].map((levels) => frame(levels.map((lv, i) => ["●", lv] as [string, number])));

// --- Wave: five bars rising and falling (900ms) ----------------------------
const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const wave = Array.from({ length: 8 }, (_, f) =>
  frame([0, 1, 2, 3, 4].map((i) => {
    const h = (f + i) % 8;
    return [BARS[h], h >= 6 ? 3 : h >= 3 ? 2 : 1] as [string, number];
  })));

// --- BouncingDots: three dots bouncing at staggered phases (500ms) ---------
const SIZES = ["˙", "•", "●"]; // small → mid → large
const BOUNCE_H = [2, 2, 1, 0, 0, 1];
const bouncingDots = Array.from({ length: 6 }, (_, f) =>
  frame([0, 1, 2].map((i) => {
    const h = BOUNCE_H[(f + i * 2) % 6];
    return [SIZES[h], h === 2 ? 3 : h === 1 ? 2 : 1] as [string, number];
  })));

// --- Leap: three dots in a row, the last one leaps to the front (1800ms) ---
// Five cells: the lit square marches right, then leaps back to the front.
const leap = [0, 1, 2, 3, 4, -1].map((head) =>
  frame(Array.from({ length: 5 }, (_, i) =>
    ["■", head < 0 ? 0 : i === head ? 3 : 0] as [string, number])));

// --- Classic: four quadrants stepping with a fading trail (1200ms) ---------
const QUAD = ["▘", "▝", "▗", "▖"];
const classic = [0, 1, 2, 3].map((f) =>
  frame(QUAD.map((ch, i) => {
    const d = (i - f + 4) % 4;
    return [ch, d === 0 ? 3 : d === 1 ? 2 : d === 2 ? 1 : 0] as [string, number];
  })));

// --- CircularDots: six dots in a ring, the brightest hops around (800ms) ----
const RING = 6;
const circularDots = Array.from({ length: RING }, (_, f) =>
  frame(Array.from({ length: RING }, (_, i) => {
    const d = (i - f + RING) % RING;
    return ["●", d === 0 ? 3 : d === 1 ? 2 : 1] as [string, number];
  })));

// --- Morph: a square rounding into a circle and back (1200ms) -------------
const morph = ([["▢", 1], ["◴", 2], ["◶", 2], ["◉", 3], ["◶", 2], ["◴", 2]] as Array<[string, number]>)
  .map((spec) => frame([spec]));

// --- Ripple: a dot rippling outward from the center (1200ms) ---------------
const ripple = [0, 1, 2, 1].map((k) =>
  frame(Array.from({ length: 5 }, (_, i) => {
    const d = Math.abs(i - 2);
    const lv = d === k ? 3 : k > 0 && d === k - 1 ? 1 : 0;
    return [d === 0 ? "●" : "·", lv] as [string, number];
  })));

// --- Swirl: a bright cell chasing its trail around a square (1200ms) -------
const PATH = [0, 1, 2, 3, 4, 3, 2, 1];
const swirl = PATH.map((_head, f) =>
  frame(Array.from({ length: 5 }, (_, i) => {
    let d = 99;
    for (let k = 0; k < PATH.length; k++) {
      if (PATH[(f - k + PATH.length) % PATH.length] === i) { d = k; break; }
    }
    return ["▪", d === 0 ? 3 : d === 1 ? 2 : d === 2 ? 1 : 0] as [string, number];
  })));

// --- Cursor: the original braille spinner, kept so the exact cursor-agent
//     look can be restored with /spinner cursor ---------------------------
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const cursorSpin = BRAILLE.map((ch) => frame([[ch, 2] as [string, number]]));

export const SPINNERS: Spinner[] = [
  { name: "linear-dots", label: "Linear dots — three dots fading in sequence", cycleMs: 900, width: 3, frames: linearDots },
  { name: "wave", label: "Wave — five bars rising and falling", cycleMs: 900, width: 5, frames: wave },
  { name: "bouncing-dots", label: "Bouncing dots — staggered bounce", cycleMs: 500, width: 3, frames: bouncingDots },
  { name: "leap", label: "Leap — the last dot leaps to the front", cycleMs: 1800, width: 5, frames: leap },
  { name: "classic", label: "Classic — quadrants stepping with a fading trail", cycleMs: 1200, width: 4, frames: classic },
  { name: "circular-dots", label: "Circular dots — the brightest dot hops the ring", cycleMs: 800, width: 6, frames: circularDots },
  { name: "morph", label: "Morph — a square rounding into a circle", cycleMs: 1200, width: 1, frames: morph },
  { name: "ripple", label: "Ripple — a dot rippling outward", cycleMs: 1200, width: 5, frames: ripple },
  { name: "swirl", label: "Swirl — a bright cell chasing its trail", cycleMs: 1200, width: 5, frames: swirl },
  { name: "cursor", label: "Cursor braille — the original cursor-agent spinner", cycleMs: 1200, width: 1, frames: cursorSpin },
];

export const DEFAULT_SPINNER = "linear-dots";

/** Frame for an animation at `elapsedMs` since the spin started. */
export function frameFor(name: string, elapsedMs: number): string {
  const sp = SPINNERS.find((x) => x.name === name) ?? SPINNERS[0];
  const n = sp.frames.length;
  const step = sp.cycleMs / n;
  const idx = Math.floor(Math.max(0, elapsedMs) / step) % n;
  return sp.frames[idx];
}
