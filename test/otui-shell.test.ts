// Phase 1 regression: the OpenTUI shell renders the cursor-agent frame and
// routes input, headlessly. This replaces most of the tmux capture work for
// day-to-day checks — tmux stays for visual acceptance.

import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { OtuiShell, mapKey } from "../src/otui/shell";
import { installKeymap } from "../src/otui/keymap";
import { createState, type UIState } from "../src/state";
import type { Key } from "../src/ui/keys";

function setupApp() {
  const s: UIState = createState("/tmp/project", "2.0.15");
  s.modelLabel = "Space Bunny Free";
  return s;
}

describe("otui shell", () => {
  test("renders header, transcript, composer and meta rows", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
    const s = setupApp();
    s.transcript.push({ role: "user", text: "say only: hello" });
    s.transcript.push({ role: "assistant", text: "hello" });

    const shell = await OtuiShell.create({ onKey: () => {}, onEdit: () => {} }, setup.renderer);
    shell.sync(s);
    await setup.renderOnce();
    // The transcript height is measured from scrollHeight, which is only
    // populated after a layout pass — mirror the app's 120ms redraw tick.
    shell.sync(s);
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Opencode");
    expect(frame).toContain("v2.0.15");
    expect(frame).toContain("hello");
    expect(frame).toContain("Space Bunny Free");
    expect(frame).toContain("/tmp/project");

    setup.renderer.destroy();
  });

  test("composer edits reach app state, control keys are routed via keymap", async () => {
    // kittyKeyboard makes a bare ESC unambiguous, so pressEscape() produces an
    // "escape" keypress immediately instead of being held as a sequence prefix
    // (a real terminal flushes it on a timer; the harness does not).
    const setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false, kittyKeyboard: true });
    const s = setupApp();
    const keys: Key[] = [];

    const shell = await OtuiShell.create(
      {
        onKey: (key) => {
          keys.push(key);
        },
        onEdit: () => {
          const { input, cursor } = shell.readComposer();
          s.input = input;
          s.cursor = cursor;
        },
      },
      setup.renderer,
    );
    shell.sync(s);
    await setup.renderOnce();

    // printable text is handled by the Textarea and mirrored into state
    await setup.mockInput.typeText("hi");
    expect(s.input).toBe("hi");

    // control keys are consumed by the keymap before the editor
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressKey("o", { ctrl: true });
    setup.mockInput.pressTab({ shift: true });
    setup.mockInput.pressEnter();
    setup.mockInput.pressEnter({ shift: true });
    setup.mockInput.pressEscape();
    await setup.renderOnce();
    expect(keys.map((k) => k.kind)).toEqual(["down", "ctrl", "tab", "enter", "enter", "esc"]);
    expect(keys.find((k) => k.kind === "tab")?.shift).toBe(true);
    // shift+enter is a newline, not a submit — distinguished via the real event
    const enters = keys.filter((k) => k.kind === "enter");
    expect(enters[0].shift).toBe(false); // plain enter → submit
    expect(enters[1].shift).toBe(true); // shift+enter → newline

    setup.renderer.destroy();
  });

  test("slash popup and sessions picker render", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
    const s = setupApp();
    s.input = "/";
    s.slashOpen = true;
    s.slashFilter = "/";
    s.sessionItems = [{ id: "ses_abc123", title: "A project session", updated: Date.now() }];
    s.sessionsOpen = true;

    const shell = await OtuiShell.create({ onKey: () => {}, onEdit: () => {} }, setup.renderer);
    shell.sync(s);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("/sessions");
    expect(frame).toContain("A project session");

    setup.renderer.destroy();
  });

  test("popup layer activates only while a picker is open", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false, kittyKeyboard: true });
    const s = setupApp();
    const keys: Key[] = [];
    const shell = await OtuiShell.create(
      { onKey: (key) => { keys.push(key); }, onEdit: () => {} },
      setup.renderer,
    );

    // no popup: up/down/escape route via the global layer
    shell.sync(s);
    setup.mockInput.pressArrow("up");
    setup.mockInput.pressEscape();
    await setup.renderOnce();
    expect(keys.map((k) => k.kind)).toEqual(["up", "esc"]);

    // open a picker: nav still works, and the popup layer is now active
    keys.length = 0;
    s.slashOpen = true;
    s.slashFilter = "/";
    shell.sync(s);
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    // the picker commits on enter (routes {kind:"enter"} via popup.commit)
    expect(keys.map((k) => k.kind)).toEqual(["down", "enter"]);

    setup.renderer.destroy();
  });

  test("popup keymap layer activates only while a picker is open", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20, exitOnCtrlC: false, kittyKeyboard: true });
    const seen: string[] = [];
    const km = installKeymap(setup.renderer, (k) => { seen.push(k.kind); });
    const names = () => km.keymap.getCommands().map((c) => c.name);

    // closed: only the global app.* layer is active
    expect(names().some((n) => n.startsWith("popup."))).toBe(false);
    expect(names()).toContain("app.navigateDown");

    // open: the popup layer takes precedence, global layer still falls through
    km.setPopupActive(true);
    expect(names()[0]).toBe("popup.navigateUp");
    expect(names()).toContain("popup.commit");
    expect(names()).toContain("app.navigateDown"); // printable fall-through owner

    km.setPopupActive(false);
    expect(names().some((n) => n.startsWith("popup."))).toBe(false);

    setup.renderer.destroy();
  });

  test("mapKey translates OpenTUI events into app keys", () => {
    const base = { sequence: "", raw: "", source: "raw", eventType: "press" } as const;
    expect(mapKey({ ...base, name: "up" })).toEqual({ kind: "up" });
    expect(mapKey({ ...base, name: "return", shift: true })).toEqual({ kind: "enter", shift: true });
    expect(mapKey({ ...base, name: "tab", shift: true })).toEqual({ kind: "tab", shift: true });
    expect(mapKey({ ...base, name: "c", ctrl: true })).toEqual({ kind: "ctrl", key: "c" });
    expect(mapKey({ ...base, name: "a", sequence: "a" })).toEqual({ kind: "char", ch: "a" });
    expect(mapKey({ ...base, name: "f13" })).toBeNull();
  });
});
