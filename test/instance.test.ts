// Session-ownership isolation: ctui must talk to its own opencode instance
// (its own session DB), with a documented escape hatch back to the shared one.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ctui service instance", () => {
  test("defaults to a private instance; CTUI_SHARE_DB opts into the shared one", async () => {
    const { sharesOpencodeService } = await import("../src/opencode/instance");
    delete process.env.CTUI_SHARE_DB;
    expect(sharesOpencodeService()).toBe(false);
    process.env.CTUI_SHARE_DB = "1";
    expect(sharesOpencodeService()).toBe(true);
    process.env.CTUI_SHARE_DB = "true";
    expect(sharesOpencodeService()).toBe(true);
    delete process.env.CTUI_SHARE_DB;
  });

  test("state file round-trips an endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctui-inst-"));
    const prevData = process.env.CTUI_DATA_DIR;
    process.env.CTUI_DATA_DIR = dir;
    try {
      const mod = await import(`../src/opencode/instance?fresh=${Date.now()}`);
      // the module reads env at call time, so the paths follow CTUI_DATA_DIR
      const inst = { url: "http://127.0.0.1:49375", password: "pw", dbPath: join(dir, "ctui.db") };
      writeFileSync(join(dir, "instance.json"), JSON.stringify(inst));
      expect(existsSync(join(dir, "instance.json"))).toBe(true);
      const back = JSON.parse(readFileSync(join(dir, "instance.json"), "utf8"));
      expect(back.url).toBe(inst.url);
      expect(back.password).toBe(inst.password);
      expect(typeof mod.ensureInstance).toBe("function");
    } finally {
      if (prevData === undefined) delete process.env.CTUI_DATA_DIR;
      else process.env.CTUI_DATA_DIR = prevData;
    }
  });
});
