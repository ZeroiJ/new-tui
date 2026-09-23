import { DEFAULT_SPINNER } from "./spinners";
import type { SlashCmd } from "./commands";

export type Mode = "agent" | "plan" | "ask";

/**
 * One rendered line-group in the transcript. This is the view model — the
 * authoritative opencode data lives in `MessageRecord`/`PartRecord` below and
 * transcript items link back to it by id.
 */
export interface TranscriptItem {
  role: "user" | "assistant" | "tool" | "system" | "error";
  text: string;
  /** opencode tool-call id (tool items only) — used for live updates */
  toolId?: string;
  /** originating opencode message (message.id) */
  messageId?: string;
  /** originating opencode part (part.id) */
  partId?: string;
  /** tool timing (ms epoch) — drives the elapsed timer on the tool line */
  startedAt?: number;
  endedAt?: number;
  /** tool output lines (agent shell tools) — collapsed, ctrl+o expands */
  output?: string[];
}

// ---------------------------------------------------------------------------
// opencode's own model: session → message → part
// ---------------------------------------------------------------------------

export type PartType = "text" | "tool" | "reasoning" | "file" | "step-start" | "step-finish";
export type ToolStatus = "pending" | "running" | "completed" | "error";

export interface ToolState {
  status: ToolStatus;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  /** opencode's own timestamps, when reported */
  time?: { start?: number; end?: number };
}

export interface MessageRecord {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  created: number;
  /** per-message token usage, if reported */
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
}

export interface PartRecord {
  id: string;
  messageID: string;
  sessionID: string;
  type: PartType;
  /** text parts */
  text?: string;
  /** tool parts */
  tool?: string;
  callID?: string;
  state?: ToolState;
  created: number;
}

export interface PermissionState {
  id: string;
  action: string;
  resources: string[];
  message?: string;
  hasSave: boolean;
}

export interface ToastState {
  title?: string;
  message: string;
  variant: "info" | "success" | "warning" | "error";
  at: number;
  until: number;
}

export interface UIState {
  cols: number;
  rows: number;
  transcript: TranscriptItem[];
  input: string;
  cursor: number;
  mode: Mode;
  modelLabel: string;
  cwd: string;
  version: string;
  tipIndex: number;
  hintsOpen: boolean;
  slashOpen: boolean;
  slashFilter: string;
  slashIndex: number;
  /** model picker: available models (preloaded) + open state */
  modelItems: { label: string; value: string }[];
  modelOpen: boolean;
  modelIndex: number;
  streaming: boolean;
  /** which loading.dev-style thinking animation to play */
  spinnerName: string;
  /** ms timestamp when the current spin started (null = not spinning) */
  spinStart: number | null;
  statusMsg: string;
  scrollOffset: number;
  permission: PermissionState | null;
  cloudMsg: string | null;
  /** "working" = waiting for first token; "running" = executing/streaming */
  phase: "idle" | "working" | "running";
  /** live output-token count for the current turn (cursor-style status line) */
  turnTokens: number;
  /** animated token counter (eases toward turnTokens) */
  tokenDisplay: number;
  /** session-cumulative output tokens at turn start (baseline for turnTokens) */
  turnBaseline: number;
  /** assistant message currently streaming (from session.text.delta) */
  liveAssistantId: string | null;
  /** transcript index of the live-streamed assistant entry (merge replaces it) */
  liveAssistantIdx: number | null;
  /** per-assistantMessageID highest ordinal seen (dedupe deltas) */
  seenOrdinals: Map<string, number>;
  /** tool-call id → transcript index (live tool line updates) */
  toolLineById: Map<string, number>;
  /** tool-call id → tool name (refreshed from message polls) */
  toolNameById: Map<string, string>;
  /** ctrl+r diff overlay */
  diffOpen: boolean;
  diffLines: string[];
  diffScroll: number;
  /** pending inbox tasks (shown under box when > 0) */
  taskCount: number;
  /** true once a turn has been submitted — swaps the box placeholder */
  followUp: boolean;
  /** opencode's own commands, fetched via command.list (refreshed on command.updated) */
  ocCommands: SlashCmd[];
  /** ctrl+o — expand collapsed tool output */
  outputExpanded: boolean;
  /** completion stamp shown for ~3s after a turn settles */
  stamp: { at: number; durMs: number; tokens: number; until: number } | null;
  /** current model's context window (from ModelInfo.limit.context) */
  contextLimit: number;
  /** context used % (from last assistant message tokens) */
  contextPct: number | null;
  /** server-pushed toast (tui.toast.show) */
  toast: ToastState | null;
  /** opencode message/part store — the authoritative model behind the view */
  messages: Map<string, MessageRecord>;
  parts: Map<string, PartRecord>;
}

export function createState(cwd: string, version: string): UIState {
  return {
    cols: process.stdout.columns ?? 120,
    rows: process.stdout.rows ?? 36,
    transcript: [],
    input: "",
    cursor: 0,
    mode: "agent",
    modelLabel: "Auto",
    cwd,
    version,
    tipIndex: 0,
    hintsOpen: false,
    slashOpen: false,
    slashFilter: "",
    slashIndex: 0,
    modelItems: [],
    modelOpen: false,
    modelIndex: 0,
    streaming: false,
    spinnerName: DEFAULT_SPINNER,
    spinStart: null,
    statusMsg: "",
    scrollOffset: 0,
    permission: null,
    cloudMsg: null,
    phase: "idle",
    turnTokens: 0,
    tokenDisplay: 0,
    turnBaseline: 0,
    liveAssistantId: null,
    liveAssistantIdx: null,
    seenOrdinals: new Map(),
    toolLineById: new Map(),
    toolNameById: new Map(),
    diffOpen: false,
    diffLines: [],
    diffScroll: 0,
    taskCount: 0,
    followUp: false,
    ocCommands: [],
    outputExpanded: false,
    stamp: null,
    contextLimit: 0,
    contextPct: null,
    toast: null,
    messages: new Map(),
    parts: new Map(),
  };
}

// ---------------------------------------------------------------------------
// small state helpers shared by the event reducer and the app controller
// ---------------------------------------------------------------------------

/** Freeze any tool timer still counting (turn end / interrupt). */
export function freezeToolTimers(s: UIState) {
  const now = Date.now();
  for (const it of s.transcript) {
    if (it.role === "tool" && it.startedAt != null && it.endedAt == null) it.endedAt = now;
  }
}

export function pushNote(s: UIState, role: TranscriptItem["role"], text: string) {
  s.transcript.push({ role, text });
}

/** Record an opencode message + parts as they arrive from `message.list`. */
export function recordMessage(s: UIState, m: MessageRecord, parts: PartRecord[] = []) {
  s.messages.set(m.id, m);
  for (const p of parts) s.parts.set(p.id, p);
}
