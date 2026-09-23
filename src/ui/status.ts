// The status strip above the input box: thinking animation + phase + token
// count, the post-turn completion stamp, server toasts, and the ? hints.

import { bold, dim, green } from "./theme";
import { fmtDur } from "./text";
import { frameFor } from "../spinners";
import { HINT_ROWS } from "../tips";
import type { UIState } from "../state";

export function statusRows(s: UIState, now: number): string[] {
  const out: string[] = [];
  if (s.cloudMsg) out.push(dim(`  ${s.cloudMsg}`));

  if (s.streaming) {
    const label = s.phase === "working" ? "Working" : "Running";
    const tok = label === "Running" && s.tokenDisplay > 0
      ? dim(`  ${s.tokenDisplay.toLocaleString("en-US")} tokens`)
      : "";
    const spin = frameFor(s.spinnerName, s.spinStart != null ? now - s.spinStart : 0);
    out.push(`  ${spin} ${bold(label)}${tok}`);
  } else if (s.stamp && now < s.stamp.until) {
    const dur = s.stamp.durMs < 60_000 ? `${(s.stamp.durMs / 1000).toFixed(1)}s` : fmtDur(s.stamp.durMs);
    const tok = s.stamp.tokens > 0 ? dim(` · ${s.stamp.tokens.toLocaleString("en-US")} tokens`) : "";
    const body = `done in ${dur}${tok}`;
    out.push(`  ${green("✓")} ${now - s.stamp.at > 2000 ? dim(body) : body}`);
  }

  // server-pushed toast (opencode tui.toast.show)
  if (s.toast && now < s.toast.until) {
    const tint = s.toast.variant === "error" ? "\x1b[31m" : s.toast.variant === "warning" ? "\x1b[33m" : "";
    out.push(`  ${tint}${s.toast.title ? bold(`${s.toast.title}: `) : ""}${s.toast.message}${tint ? "\x1b[0m" : ""}`);
  }
  return out;
}

export function hintsRows(s: UIState): string[] {
  return s.hintsOpen ? ["", ...HINT_ROWS.map(dim)] : [];
}
