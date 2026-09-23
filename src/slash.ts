// Local slash commands. opencode's own commands bypass this file entirely —
// they run server-side through `session.command`.

import { commandList } from "./commands";
import { SPINNERS } from "./spinners";
import * as oc from "./opencode";
import type { App } from "./app";

export async function runSlash(app: App, cmd: string, arg: string): Promise<string | null> {
  const s = app.s;
  const sid = () => app.sessionID;

  switch (cmd) {
    case "/quit":
    case "/exit":
      app.quitApp();
      return null;

    case "/clear":
      s.transcript = [];
      return null;

    case "/help": {
      const all = commandList(s);
      const ocCmds = all.filter((c) => c.source === "opencode");
      const local = all.filter((c) => c.source !== "opencode");
      const body = [
        ...(ocCmds.length ? ["opencode commands:", ...ocCmds.map((c) => `${c.name} — ${c.desc}`), ""] : []),
        ...(local.length ? ["this TUI:", ...local.map((c) => `${c.name} — ${c.desc}`)] : []),
      ].join("\n");
      s.transcript.push({ role: "assistant", text: `${body}\n\nKeys: esc interrupt • Ctrl+L clear • Ctrl+G editor • Ctrl+O expand output • Shift+Tab mode • \\+Enter newline` });
      return null;
    }

    case "/new": {
      const created = await oc.createSession(s.cwd, arg || "Cursor-look session");
      const id = String(created["id"]);
      app.sessionID = id;
      s.transcript.push({ role: "system", text: `New opencode session ${id}` });
      return id;
    }

    case "/ls": {
      const list = await oc.listSessions();
      const lines = list.slice(0, 15).map((x) => `${String(x["id"])}  ${String((x["title"] as string) ?? "(untitled)")}`);
      s.transcript.push({ role: "assistant", text: lines.join("\n") || "(no sessions)" });
      return null;
    }

    case "/resume": {
      if (!arg) {
        s.transcript.push({ role: "error", text: "Usage: /resume <session-id>" });
        return null;
      }
      try {
        app.sessionID = arg;
        s.transcript = [];
        s.messages.clear();
        s.parts.clear();
        s.followUp = false;
        await app.loadHistory();
        await app.resolveModel();
        s.transcript.push({ role: "system", text: `Resumed ${arg}` });
        return arg;
      } catch (e) {
        s.transcript.push({ role: "error", text: String(e) });
        return null;
      }
    }

    case "/compact":
      await oc.compactSession(sid());
      s.transcript.push({ role: "system", text: "Session compacted." });
      return null;

    case "/fork": {
      const f = await oc.forkSession(sid());
      const id = String(f["id"]);
      s.transcript.push({ role: "system", text: `Forked → ${id}` });
      return id;
    }

    case "/plan":
      s.mode = "plan";
      if (arg) await app.submit(sid(), `[PLAN MODE - design approach, ask clarifying questions, no edits]\n${arg}`);
      else s.transcript.push({ role: "system", text: "Plan mode on (Shift+Tab to switch back)." });
      return null;

    case "/ask":
      s.mode = "ask";
      if (arg) await app.submit(sid(), `[ASK MODE - read-only Q&A, no edits or command execution]\n${arg}`);
      else s.transcript.push({ role: "system", text: "Ask mode on (read-only)." });
      return null;

    case "/model": {
      const models = await oc.listModels();
      if (!arg) {
        const names = models
          .map((m) => `${String(m["name"] ?? m["id"])}  (${String(m["providerID"] ?? m["provider"] ?? "")}/${String(m["id"])})`)
          .slice(0, 20);
        s.transcript.push({ role: "assistant", text: `Models (opencode):\n${names.join("\n") || "(none listed)"}\n\nUse /model <provider/model> to switch.` });
      } else {
        const hit = models.find(
          (m) =>
            String(m["id"]) === arg ||
            `${String(m["providerID"] ?? m["provider"])}/${String(m["id"])}` === arg ||
            String(m["name"] ?? "").toLowerCase() === arg.toLowerCase(),
        );
        const providerID = String(hit?.["providerID"] ?? hit?.["provider"] ?? (arg.includes("/") ? arg.split("/")[0] : "opencode"));
        const id = String(hit?.["id"] ?? (arg.includes("/") ? arg.split("/").slice(1).join("/") : arg));
        const friendly = String(hit?.["name"] ?? id);
        try {
          await oc.switchModel(sid(), { providerID, id });
          s.modelLabel = friendly;
          s.transcript.push({ role: "system", text: `Model → ${friendly}` });
          s.contextLimit = await oc.modelContextLimit({ providerID, id });
          void app.refreshContext();
        } catch (e) {
          s.transcript.push({ role: "error", text: `switchModel failed: ${String(e)}` });
        }
      }
      return null;
    }

    case "/agent": {
      const agents = await oc.listAgents();
      if (!arg) {
        const names = agents.slice(0, 20).map((m) => String((m as Record<string, unknown>)["name"] ?? (m as Record<string, unknown>)["id"] ?? JSON.stringify(m)));
        s.transcript.push({ role: "assistant", text: `Agents:\n${names || "(none listed)"}` });
      } else {
        s.transcript.push({ role: "system", text: `Agent → ${arg} (applies to next prompt)` });
        (s as unknown as Record<string, unknown>)["pendingAgent"] = arg;
      }
      return null;
    }

    case "/mcp":
    case "/sandbox":
    case "/auto-review":
    case "/run-everything": {
      if (cmd === "/run-everything") {
        app.autoApprove = !app.autoApprove;
        s.transcript.push({ role: "system", text: `Run Everything ${app.autoApprove ? "enabled (auto-approve)" : "disabled"}` });
      } else {
        s.transcript.push({ role: "assistant", text: `${cmd}: backed by opencode permissions. Use /run-everything to toggle auto-approve (currently ${app.autoApprove ? "on" : "off"}).` });
      }
      return null;
    }

    case "/add-dir":
      if (arg) { s.cwd = arg; s.transcript.push({ role: "system", text: `Workspace → ${arg}` }); }
      else s.transcript.push({ role: "error", text: "Usage: /add-dir <path>" });
      return null;

    case "/goal":
      s.transcript.push({ role: "system", text: `Durable goal started: ${arg || "(no objective)"} — continuing while idle (local emulation).` });
      if (arg) await app.submit(sid(), `[GOAL - continue until done, working autonomously]\n${arg}`);
      return null;

    case "/spinner": {
      if (!arg) {
        const list = SPINNERS.map((x) => `${x.name.padEnd(15)} ${x.label}  ${x.cycleMs}ms`).join("\n");
        s.transcript.push({ role: "assistant", text: `Thinking animations (loading.dev):\n${list}\n\nUse /spinner <name>. Current: ${s.spinnerName}` });
        return null;
      }
      const hit = SPINNERS.find((x) => x.name === arg);
      if (!hit) {
        s.transcript.push({ role: "error", text: `Unknown spinner "${arg}". Try: ${SPINNERS.map((x) => x.name).join(", ")}` });
        return null;
      }
      s.spinnerName = hit.name;
      s.spinStart = s.streaming ? Date.now() : null;
      s.transcript.push({ role: "system", text: `Spinner → ${hit.name} (${hit.label})` });
      return null;
    }

    case "/diff":
      await app.openDiffOverlay();
      return null;

    default: {
      // Anything opencode itself provides runs server-side through the normal
      // prompt pipeline, so it streams, renders and stamps like a turn.
      const bare = cmd.replace(/^\//, "");
      const known = s.ocCommands.find((c) => c.name.replace(/^\//, "") === bare);
      if (known) {
        await app.submit(sid(), `${"/" + bare}${arg ? " " + arg : ""}`, {
          run: () => oc.runCommand(sid(), bare, arg),
        });
        return null;
      }
      s.transcript.push({ role: "error", text: `Unknown command ${cmd}. Try /help.` });
      return null;
    }
  }
}
