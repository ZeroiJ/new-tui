// OpenTUI Phase 0 gate: prove the renderer works headlessly, so the migration
// can be tested without tmux captures. Mirrors the live spike's essentials —
// layout, a focused textarea, parsed keys including Shift+Tab, and paste.

import { describe, expect, test } from "bun:test";
import { BoxRenderable, TextRenderable, TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

describe("opentui headless", () => {
  test("renders a frame, edits the textarea, and parses keys", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20, exitOnCtrlC: false });
    const { renderer, mockInput, renderOnce, captureCharFrame } = setup;

    const panel = new BoxRenderable(renderer, { id: "panel", width: 40, height: 1, backgroundColor: "#282c34" });
    panel.add(new TextRenderable(renderer, { id: "panelText", content: "hello panel" }));
    const input = new TextareaRenderable(renderer, {
      id: "input",
      width: 40,
      height: 3,
      backgroundColor: "#343434",
      cursorStyle: { style: "block", blinking: false },
    });
    const seen: string[] = [];
    renderer.keyInput.on("keypress", (key) => {
      seen.push([key.name, key.ctrl ? "ctrl" : "", key.shift ? "shift" : ""].filter(Boolean).join("+"));
    });
    renderer.root.add(panel);
    renderer.root.add(input);
    input.focus();

    await renderOnce();
    expect(captureCharFrame()).toContain("hello panel");

    // typed text lands in the focused editor
    await mockInput.typeText("abc");
    await renderOnce();
    expect(input.plainText).toBe("abc");

    // arrows / ctrl+o / shift+tab all arrive as one parsed event each
    // (typed "abc" also emitted a, b, c)
    mockInput.pressArrow("down");
    mockInput.pressKey("o", { ctrl: true });
    mockInput.pressTab({ shift: true });
    await mockInput.pasteBracketedText("pasted");
    await renderOnce();
    expect(seen).toEqual(["a", "b", "c", "down", "o+ctrl", "tab+shift"]);
    expect(input.plainText).toContain("pasted");

    renderer.destroy();
  });
});
