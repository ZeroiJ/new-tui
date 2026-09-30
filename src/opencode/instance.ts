// ctui's own opencode service instance.
//
// Requirement: work done in ctui should live in ctui, not in the official
// opencode service's session store. opencode v2 stores sessions in a single
// SQLite DB (OPENCODE_DB, ~1.5G) that belongs to whichever service process
// opened it, so pointing ctui at its own DB gives true ownership: ctui's
// conversations never appear in opencode's session list, and opencode's never
// appear in ctui's.
//
// Why we spawn our own process instead of using the SDK's Service.ensure():
//   - `serve --service` is single-instance per machine (shared registration +
//     lock), so a second registered service cannot coexist with the running
//     opencode service.
//   - v2.0.20 does not support OPENCODE_DATA_DIR / OPENCODE_APPNAME, and it
//     ignores XDG_STATE_HOME for the service registration, so the registration
//     file cannot be redirected either.
// A plain `serve --port <n>` bypasses the registry entirely: it binds its own
// port, honours OPENCODE_DB, and prints its URL + basic-auth password.
//
// Escape hatch: CTUI_SHARE_DB=1 talks to the shared opencode service instead
// (the pre-isolation behaviour, useful for one-off cross-tool work).

import { OpenCode } from "@opencode/client";
import type { OCClient } from "./client";
import { binPath } from "../update";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 49375;

export interface Instance {
  url: string;
  password: string;
  dbPath: string;
}

function dataDir(): string {
  const base = process.env.CTUI_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "ctui");
  return base;
}

function dbPath(): string {
  return process.env.CTUI_DB ?? join(dataDir(), "ctui.db");
}

function statePath(): string {
  return join(dataDir(), "instance.json");
}

function port(): number {
  const n = Number(process.env.CTUI_PORT ?? DEFAULT_PORT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

/** True when ctui should share the official opencode service (escape hatch). */
export function sharesOpencodeService(): boolean {
  return process.env.CTUI_SHARE_DB === "1" || process.env.CTUI_SHARE_DB === "true";
}

function readState(): Instance | null {
  try {
    if (!existsSync(statePath())) return null;
    const raw = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<Instance>;
    if (raw?.url && raw?.password) return { url: raw.url, password: raw.password, dbPath: dbPath() };
    return null;
  } catch {
    return null;
  }
}

function writeState(inst: Instance) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(inst, null, 2));
  } catch {
    /* best effort — we can always re-derive by spawning */
  }
}

function authHeader(password: string): Record<string, string> {
  return { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") };
}

/** Is a previously-recorded instance still alive and ours? */
async function isHealthy(inst: Instance): Promise<boolean> {
  try {
    const c = OpenCode.make({ baseUrl: inst.url, headers: authHeader(inst.password) });
    const info = await (c as unknown as { server: { info: () => Promise<unknown> } }).server.info();
    return Boolean(info);
  } catch {
    return false;
  }
}

/**
 * Ensure ctui's own service is running, spawning `opencode2 serve --port` with
 * OPENCODE_DB pointed at ctui's database. Reuses a healthy instance if one is
 * already up.
 */
export async function ensureInstance(): Promise<Instance> {
  const existing = readState();
  if (existing && (await isHealthy(existing))) return existing;

  const bin = await binPath();
  if (!bin) throw new Error("opencode2 binary not found (needed to start ctui's service instance)");

  const db = dbPath();
  mkdirSync(dataDir(), { recursive: true });
  const p = port();

  const proc = Bun.spawn([bin, "serve", "--port", String(p)], {
    env: { ...process.env, OPENCODE_DB: db },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // Detach so the instance is a true background service that survives ctui
    // exiting (or the terminal closing). unref() alone does not detach the
    // child from our process group, so it would die with us.
    detached: true,
  });

  // The server prints "server listening on <url>" and "server password <pw>".
  const inst = await new Promise<Instance>((resolve, reject) => {
    let url = "";
    let password = "";
    const timer = setTimeout(() => reject(new Error("ctui service did not report a URL in time")), 30_000);
    const decoder = new TextDecoder();
    (async () => {
      try {
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          const text = decoder.decode(chunk, { stream: true });
          const u = text.match(/server listening on (http:\/\/\S+)/);
          if (u) url = u[1];
          const pw = text.match(/server password (\S+)/);
          if (pw) password = pw[1];
          if (url && password) {
            clearTimeout(timer);
            resolve({ url, password, dbPath: db });
            return;
          }
        }
        clearTimeout(timer);
        reject(new Error("ctui service exited before reporting a URL"));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    })();
  });

  // Detach: the instance is a background service that outlives this process,
  // mirroring how `opencode2 service` behaves. It is reused on the next start.
  proc.unref?.();

  writeState(inst);
  return inst;
}
/** Build an API client bound to ctui's own instance. */
export function makeClient(inst: Instance): OCClient {
  return OpenCode.make({ baseUrl: inst.url, headers: authHeader(inst.password) }) as unknown as OCClient;
}

/** Stop ctui's instance (for `ctui --stop-service`). */
export async function stopInstance(): Promise<boolean> {
  const inst = readState();
  if (!inst) return false;
  const p = new URL(inst.url).port;
  if (!p) return false;

  // Find the PID actually listening on our port and signal it directly.
  // Pattern-matching (pkill -f) is deliberately avoided: the pattern also
  // matches the shell running pkill, and bracket-escaping to dodge that stops
  // matching the real process. Addressing the port's own PID is unambiguous and
  // can never touch the official opencode service on a different port.
  const pids = listenerPids(p);
  if (pids.length === 0) {
    clearState();
    return false; // nothing running
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Poll until the port is released.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (listenerPids(p).length === 0) {
      clearState();
      return true;
    }
  }
  return false; // still up after ~3s
}

/** PIDs listening on `port` (empty when free). */
function listenerPids(port: string): number[] {
  try {
    const out = execFileSync("ss", ["-ltnpH"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pids: number[] = [];
    for (const line of out.split("\n")) {
      if (!line.includes(`:${port} `)) continue;
      for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(Number(m[1]));
    }
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

function clearState() {
  try {
    if (existsSync(statePath())) writeFileSync(statePath(), "{}");
  } catch {
    /* best effort */
  }
}

/** Cycle ctui's instance so it runs a freshly-updated binary. */
export async function restartInstance(): Promise<void> {
  await stopInstance();
  clearState();
}
