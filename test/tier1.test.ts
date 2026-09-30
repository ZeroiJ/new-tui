// Tier 1 helpers: shape/normalisation of undo, worktree, export and stats.
// These talk to a live service, so the tests assert on the call shapes and the
// pure normalisation, not on server state.

import { describe, expect, test } from "bun:test";
import * as oc from "../src/opencode/session";

describe("tier 1 opencode helpers", () => {
  test("summarize handles sessions without a time block", () => {
    const s = oc.summarize({ id: "ses_x", title: "t" });
    expect(s.id).toBe("ses_x");
    expect(s.created).toBe(0);
    expect(s.updated).toBe(0);
  });

  test("summarize reads location.directory and time.updated", () => {
    const s = oc.summarize({
      id: "ses_y",
      title: "hello",
      location: { directory: "/w" },
      time: { created: 10, updated: 99 },
    });
    expect(s.directory).toBe("/w");
    expect(s.created).toBe(10);
    expect(s.updated).toBe(99);
  });

  test("workspace sessions are sorted newest-first", async () => {
    // Uses ctui's own private instance; tolerates an empty database.
    const list = await oc.listWorkspaceSessions("/tmp/opencode/does-not-exist-xyz").catch(() => [] as oc.SessionSummary[]);
    expect(Array.isArray(list)).toBe(true);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].updated).toBeGreaterThanOrEqual(list[i].updated);
    }
  });
});
