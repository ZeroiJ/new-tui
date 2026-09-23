#!/usr/bin/env bun
// Entry point: parse args, then either print once (`-p`) or hand off to the
// interactive app. All the real work lives in ./app.

import { App } from "./app";
import * as oc from "./opencode";

interface Args {
  prompt: string;
  mode: "agent" | "plan" | "ask" | null;
  resume: string | null;
  cont: boolean;
  model: string | null;
  workspace: string;
  print: boolean;
  trust: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { prompt: "", mode: null, resume: null, cont: false, model: null, workspace: process.cwd(), print: false, trust: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "-p" || t === "--print") a.print = true;
    else if (t === "--mode" && argv[i + 1]) { const m = argv[++i]; if (m === "plan" || m === "ask") a.mode = m; }
    else if (t === "--plan") a.mode = "plan";
    else if ((t === "--resume" || t === "--continue") && !argv[i + 1]?.startsWith("-")) { a.resume = argv[++i] ?? ""; a.cont = true; }
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
  const sessions = await oc.listSessions();
  let sid: string | undefined;
  if (args.cont && sessions.length > 0) sid = String(sessions[0]["id"]);
  if (args.resume) sid = args.resume;
  if (!sid) {
    const s = await oc.createSession(args.workspace, undefined, args.model ?? undefined);
    sid = String(s["id"]);
  }
  let text = args.prompt || "Hello";
  if (args.mode === "plan") text = `[PLAN MODE - propose a plan, no edits]\n${text}`;
  if (args.mode === "ask") text = `[ASK MODE - read-only Q&A]\n${text}`;
  await oc.sendPrompt(sid, text, args.model ? { model: args.model } : undefined);
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const msgs = await oc.listMessages(sid);
    const last = [...msgs].reverse().find((m) => m.role.includes("assistant") && m.text.trim());
    if (last) {
      process.stdout.write(last.text + "\n");
      return;
    }
  }
  process.stdout.write("(no response yet — resume with --continue)\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.print) {
    await runPrintMode(args);
    process.exit(0);
  }

  const app = new App({
    workspace: args.workspace,
    mode: args.mode ?? undefined,
    model: args.model ?? undefined,
    prompt: args.prompt,
    resume: args.resume ?? undefined,
    continueLast: args.cont,
  });
  await app.start();
  if (args.prompt) app.promptOnce(args.prompt);
}

await main();
