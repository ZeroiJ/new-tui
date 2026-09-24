#!/usr/bin/env bun
// Entry point: parse args, then either print once (`-p`) or hand off to the
// interactive app. All the real work lives in ./app.

import { App } from "./app";
import * as oc from "./opencode";
import { binPath, checkForUpdate, runUpdate } from "./update";

interface Args {
  prompt: string;
  mode: "agent" | "plan" | "ask" | null;
  resume: string | null;
  cont: boolean;
  model: string | null;
  workspace: string;
  print: boolean;
  trust: boolean;
  updateCheck: boolean;
  renderer: "ansi" | "opentui";
}

function parseArgs(argv: string[]): Args {
  // Default renderer is the OpenTUI engine; CTUI_RENDERER=ansi or --renderer=ansi
  // opts back into the legacy string renderer.
  const a: Args = { prompt: "", mode: null, resume: null, cont: false, model: null, workspace: process.cwd(), print: false, trust: false, updateCheck: process.env.CTUI_NO_UPDATE_CHECK !== "1", renderer: process.env.CTUI_RENDERER === "ansi" ? "ansi" : "opentui" };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "-p" || t === "--print") a.print = true;
    else if (t?.startsWith("--renderer=")) {
      // equals form: --renderer=opentui
      const r = t.slice("--renderer=".length);
      if (r !== "ansi" && r !== "opentui") {
        process.stderr.write(`unknown renderer "${r}" (use ansi or opentui)\n`);
        process.exit(2);
      }
      a.renderer = r;
    }
    else if (t === "--renderer" && argv[i + 1]) {
      // space form: --renderer opentui
      const r = argv[++i];
      if (r !== "ansi" && r !== "opentui") {
        process.stderr.write(`unknown renderer "${r}" (use ansi or opentui)\n`);
        process.exit(2);
      }
      a.renderer = r;
    }
    else if (t === "--no-update-check") a.updateCheck = false;
    else if (t === "--mode" && argv[i + 1]) { const m = argv[++i]; if (m === "plan" || m === "ask") a.mode = m; }
    else if (t === "--plan") a.mode = "plan";
    else if (t === "--resume" && argv[i + 1] && !argv[i + 1].startsWith("-")) { a.resume = argv[++i]; a.cont = true; }
    else if (t === "--continue" || t === "-c") a.cont = true;
    else if (t === "--model" && argv[i + 1]) a.model = argv[++i];
    else if ((t === "--workspace" || t === "--add-dir") && argv[i + 1]) a.workspace = argv[++i];
    else if (t === "--trust" || t === "-f" || t === "--yolo" || t === "--force") a.trust = true;
    else if (!t.startsWith("-")) rest.push(t);
  }
  a.prompt = rest.join(" ");
  return a;
}

/** Headless one-shot: prompt, poll, print the answer. */
async function runPrintMode(args: Args) {
  await oc.getClient();
  let sid: string | undefined;
  // --continue attaches to the newest session in *this* workspace, never one
  // from another project (which may be another client's live turn).
  if (args.cont) {
    const latest = await oc.latestWorkspaceSession(args.workspace).catch(() => null);
    if (latest) sid = latest.id;
  }
  if (args.resume) sid = args.resume;
  if (!sid) {
    const s = await oc.createSession(args.workspace, undefined, args.model ?? undefined);
    sid = String(s["id"]);
  }
  let text = args.prompt || "Hello";
  if (args.mode === "plan") text = `[PLAN MODE - propose a plan, no edits]\n${text}`;
  if (args.mode === "ask") text = `[ASK MODE - read-only Q&A]\n${text}`;
  // Snapshot before sending: on --continue the previous turn's answer is still
  // in the session, so only messages created by *this* prompt count.
  const pre = new Set((await oc.listMessages(sid).catch(() => [])).map((m) => m.id));
  await oc.sendPrompt(sid, text, args.model ? { model: args.model } : undefined);
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const msgs = await oc.listMessages(sid);
    const last = [...msgs].reverse().find((m) => !pre.has(m.id) && m.role.includes("assistant") && m.text.trim());
    if (last) {
      process.stdout.write(last.text + "\n");
      return;
    }
  }
  process.stdout.write("(no response yet — resume with --continue)\n");
}

/**
 * Check the opencode2 release on startup. Silent when the installed version
 * is current; a bar + install + service restart when a same-major update
 * landed. The registry check runs alongside the service handshake, so the
 * common (up-to-date) path costs nothing.
 */
async function maybeUpdateOpencode() {
  const check = checkForUpdate();
  await oc.getClient().catch(() => null); // warm the service while we wait
  const info = await check;
  if (!info) return;
  const bin = await binPath();
  if (!bin) return;
  const res = await runUpdate(info, bin);
  if (res.applied) {
    // The service restarted from the new binary — drop the stale client.
    oc.resetClient();
    await oc.getClient().catch(() => null);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.print) {
    await runPrintMode(args);
    process.exit(0);
  }

  if (args.updateCheck) await maybeUpdateOpencode();

  const app = new App({
    workspace: args.workspace,
    mode: args.mode ?? undefined,
    model: args.model ?? undefined,
    prompt: args.prompt,
    resume: args.resume ?? undefined,
    continueLast: args.cont,
    renderer: args.renderer,
  });
  await app.start();
  if (args.prompt) app.promptOnce(args.prompt);
}

await main();
