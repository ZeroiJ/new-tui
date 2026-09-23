// Startup update check for the opencode2 service binary.
//
// `opencode2` is the bun-global package @opencode/cli, so "updating the API"
// means installing the newest release of that package and restarting the
// background service. The check itself is a single registry fetch (2s ceiling)
// that runs in parallel with the service handshake: nothing newer means no
// output at all, something newer means a bar appears and the install runs on
// its own. Same-major updates auto-apply; a major bump is announced with the
// command to run but never applied for you.

import { frameFor, DEFAULT_SPINNER } from "./spinners";
import { bold, dim, green, red } from "./ui/theme";

const PKG = "@opencode/cli";
const REGISTRY = `https://registry.npmjs.org/${PKG}/latest`;
const CHECK_TIMEOUT_MS = 2000;
const FRAME_MS = 80;

export interface UpdateInfo {
  current: string;
  latest: string;
  /** latest crosses a major boundary — announce, never auto-apply */
  major: boolean;
}

/** Semver-ish compare: -1 | 0 | 1. Missing components count as 0. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Absolute path of the opencode2 binary, or null if it isn't installed. */
export async function binPath(): Promise<string | null> {
  for (const cand of [process.env.OPENCODE2_BIN, "opencode2", `${process.env.HOME}/.bun/bin/opencode2`]) {
    if (!cand) continue;
    if (cand.includes("/")) {
      if (await Bun.file(cand).exists()) return cand;
      continue;
    }
    const probe = Bun.spawn(["which", cand], { stdout: "pipe", stderr: "ignore" });
    const path = (await new Response(probe.stdout).text()).trim();
    await probe.exited;
    if (path) return path;
  }
  return null;
}

/** Version the installed binary reports (`opencode2 --version`). */
export async function installedVersion(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const m = `${out}\n${err}`.match(/v?(\d+\.\d+\.\d+[\w.+-]*)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ? String(body.version) : null;
  } catch {
    return null;
  }
}

/**
 * Compare the installed opencode2 against the npm registry.
 * Returns null when current, unknown, or when the registry is unreachable.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const bin = await binPath();
    if (!bin) return null;
    const [current, latest] = await Promise.all([installedVersion(bin), latestVersion()]);
    if (!current || !latest) return null;
    if (compareSemver(latest, current) <= 0) return null;
    const [curMajor] = current.split(".");
    const [newMajor] = latest.split(".");
    return { current, latest, major: curMajor !== newMajor };
  } catch {
    return null;
  }
}

/** Draw `label` with a thinking animation while `work` runs. */
async function withSpinner(label: string, work: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  let frame = "";
  const paint = () => {
    frame = frameFor(DEFAULT_SPINNER, Date.now() - t0);
    process.stdout.write(`\r\x1b[K  ${frame} ${label}`);
  };
  paint();
  const timer = setInterval(paint, FRAME_MS);
  try {
    await work();
  } finally {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K");
  }
}

export interface UpdateResult {
  applied: boolean;
  error?: string;
}

/**
 * Show the update bar and (for same-major bumps) install + restart the
 * service. Returns what happened so the caller can rebuild its client.
 */
export async function runUpdate(info: UpdateInfo, bin: string): Promise<UpdateResult> {
  if (info.major) {
    process.stdout.write(
      `\n  ${dim("↑")} opencode2 ${info.current} → ${bold(info.latest)} ${dim("(major — not auto-applied)")}\n` +
        `  ${dim(`run: bun add -g ${PKG}@latest && opencode2 service restart`)}\n`,
    );
    return { applied: false };
  }

  if (process.env.CTUI_UPDATE_DRYRUN === "1") {
    await withSpinner(`opencode2 ${info.current} → ${info.latest} · updating… ${dim("(dry run)")}`, () =>
      new Promise((r) => setTimeout(r, 900)),
    );
    process.stdout.write(
      `\n  ${dim("↑")} opencode2 ${info.current} → ${bold(info.latest)} ${dim("(dry run — nothing installed)")}\n` +
        `  ${dim(`would run: bun add -g ${PKG}@latest && opencode2 service restart`)}\n`,
    );
    return { applied: false };
  }

  try {
    await withSpinner(`opencode2 ${info.current} → ${info.latest} · updating…`, async () => {
      // process.execPath is the bun binary running this TUI — no PATH lookup.
      const install = Bun.spawn([process.execPath, "add", "-g", `${PKG}@latest`], { stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text()]);
      const code = await install.exited;
      if (code !== 0) throw new Error((err || out).trim().split("\n").slice(-2).join(" ") || `bun add exited ${code}`);
      // Restart so the service process actually runs the new binary.
      const restart = Bun.spawn([bin, "service", "restart"], { stdout: "pipe", stderr: "pipe" });
      await new Response(restart.stdout).text();
      await restart.exited;
    });
    process.stdout.write(
      `\n  ${green("✓")} opencode2 updated to ${green(info.latest)} ${dim("· service restarted")}\n`,
    );
    return { applied: true };
  } catch (e) {
    process.stdout.write(`\n  ${red("!")} opencode2 update failed: ${dim(String(e))}\n`);
    return { applied: false, error: String(e) };
  }
}
