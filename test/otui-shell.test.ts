// Phase 1 regression: the OpenTUI shell renders the cursor-agent frame and
// routes input, headlessly. This replaces most of the tmux capture work for
// day-to-day checks — tmux stays for visual acceptance.

import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { OtuiShell, mapKey } from "../src/otui/shell";
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

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Opencode");
    expect(frame).toContain("v2.0.15");
    expect(frame).toContain("hello");
    expect(frame).toContain("Space Bunny Free");
    expect(frame).toContain("/tmp/project");

    setup.renderer.destroy();
  });

  test("composer edits reach app state, control keys are routed", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
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

    // control keys are intercepted before the editor
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressKey("o", { ctrl: true });
    setup.mockInput.pressTab({ shift: true });
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    expect(keys.map((k) => k.kind)).toEqual(["down", "ctrl", "tab", "enter"]);
    expect(keys.find((k) => k.kind === "tab")?.shift).toBe(true);

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
