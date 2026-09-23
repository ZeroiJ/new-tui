// Slash-command, /model and /sessions popups, with a scrolling window that
// keeps the highlighted row visible.

import { bold, dim } from "./theme";
import { relTime } from "./text";
import { commandList } from "../commands";
import type { UIState } from "../state";

/** Keep the selected row visible in a scrolling popup window. */
export function popupWindow<T>(items: T[], index: number, max: number): { start: number; visible: T[] } {
  const maxStart = Math.max(0, items.length - max);
  const start = Math.max(0, Math.min(maxStart, index - Math.floor((max - 1) / 2)));
  return { start, visible: items.slice(start, start + max) };
}

const MAX_ROWS = 8;

export function modelPopup(s: UIState): string[] {
  const q = (s.input.startsWith("/model ") ? s.input.slice(7) : "").toLowerCase();
  const all = s.modelItems.filter(
    (m) => !q || m.label.toLowerCase().includes(q) || m.value.toLowerCase().includes(q),
  );
  const out: string[] = [dim(`   /model [${q}]  Select model (Tab to edit, Enter to pick)`)];
  if (all.length === 0) out.push(dim("   (no matching models)"));
  const { start, visible } = popupWindow(all, s.modelIndex, MAX_ROWS);
  if (start > 0) out.push(dim(`   ↑ ${start} more above`));
  visible.forEach((m, i) => {
    const idx = start + i;
    const arrow = idx === s.modelIndex ? "→" : " ";
    const name = m.label.padEnd(34);
    out.push(
      idx === s.modelIndex ? `   ${arrow} ${bold(name)} ${dim(m.value)}` : dim(`   ${arrow} ${name} ${m.value}`),
    );
  });
  if (start + MAX_ROWS < all.length) out.push(dim(`   ↓ ${all.length - start - MAX_ROWS} more below`));
  return out;
}

/** Sessions in the current workspace, newest first. */
export function sessionsPopup(s: UIState): string[] {
  const q = (s.input.startsWith("/sessions ") ? s.input.slice(10) : "").toLowerCase();
  const all = s.sessionItems.filter(
    (it) => !q || it.title.toLowerCase().includes(q) || it.id.toLowerCase().includes(q),
  );
  const out: string[] = [dim(`   /sessions [${q}]  this workspace  (↑/↓ browse · Enter resume · Tab id · Esc close)`)];
  if (all.length === 0) out.push(dim(q ? "   (no matching sessions)" : "   (no sessions in this workspace yet)"));
  const { start, visible } = popupWindow(all, s.sessionIndex, MAX_ROWS);
  if (start > 0) out.push(dim(`   ↑ ${start} more above`));
  visible.forEach((it, i) => {
    const idx = start + i;
    const arrow = idx === s.sessionIndex ? "→" : " ";
    const age = relTime(it.updated).padStart(6);
    const title = it.title.length > 46 ? it.title.slice(0, 45) + "…" : it.title;
    const name = title.padEnd(46);
    const id = dim(it.id.slice(0, 12));
    out.push(idx === s.sessionIndex ? `   ${arrow} ${bold(name)} ${dim(age)}  ${id}` : dim(`   ${arrow} ${name} ${age}  ${it.id.slice(0, 12)}`));
  });
  if (start + MAX_ROWS < all.length) out.push(dim(`   ↓ ${all.length - start - MAX_ROWS} more below`));
  return out;
}

export function slashPopup(s: UIState): string[] {
  const q = s.slashFilter.toLowerCase();
  const all = commandList(s).filter((c) => c.name.toLowerCase().startsWith(q || "/"));
  const out: string[] = [];
  if (all.length === 0) out.push(dim("   (no matching commands)"));
  const { start, visible } = popupWindow(all, s.slashIndex, MAX_ROWS);
  if (start > 0) out.push(dim(`   ↑ ${start} more above`));
  visible.forEach((c, i) => {
    const idx = start + i;
    const arrow = idx === s.slashIndex ? "→" : " ";
    const name = c.name.padEnd(30);
    out.push(
      idx === s.slashIndex ? `   ${arrow} ${bold(name)} ${dim(c.desc)}` : dim(`   ${arrow} ${name} ${c.desc}`),
    );
  });
  if (start + MAX_ROWS < all.length) out.push(dim(`   ↓ ${all.length - start - MAX_ROWS} more below`));
  return out;
}
