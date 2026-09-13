export class CodexChatLeaseLostError extends Error {
  constructor() {
    super("Codex chat turn lease is no longer owned by this worker.");
    this.name = "CodexChatLeaseLostError";
  }
}

// A task can become terminal after its durable turn is queued but before the engine starts. This
// is distinct from losing the turn lease: the current worker still owns the turn and must settle
// it immediately instead of leaving it running until lease expiry.
export class TaskTurnTerminalError extends Error {
  constructor() {
    super("opencompany task is already terminal.");
    this.name = "TaskTurnTerminalError";
  }
}

// Transient provider failures must preserve the durable user turn. Before an engine starts, the
// worker retries the same turn from scratch. After the engine boundary, the next claim uses the
// persisted recovery state to fence any leftover process and resume safely instead of projecting a
// failed assistant message.
export class CodexChatRetryableInfrastructureError extends Error {
  override readonly cause: unknown;
  readonly diagnosticMessage: string | null;

  constructor(message: string, cause: unknown, diagnosticMessage?: string) {
    super(message);
    this.name = "CodexChatRetryableInfrastructureError";
    this.cause = cause;
    this.diagnosticMessage = diagnosticMessage?.trim() || null;
  }
}

const FAILURE_MESSAGE_LIMIT = 500;
export const UNREADABLE_ENGINE_FAILURE_MESSAGE =
  "The coding engine failed with an unreadable infrastructure error.";

// Turn and session failure text renders as a one-line status in chat, but raw infrastructure
// errors are not one presentable line: provider proxies have returned whole HTML error pages
// (a 502 body reached goat.codex_chat_turns.error in production), engine stderr carries ANSI
// colour codes, and stack traces span many lines. Reduce failures to a single bounded line at
// the persistence boundary; the raw form stays available in failure diagnostics and logs.
export function presentableEngineFailureMessage(message: string) {
  const withoutAnsi = message.replaceAll(/\u001b\[[0-9;]*[A-Za-z]/gu, "");
  const collapsed = withoutAnsi
    .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (!collapsed || /<\/?(?:!doctype|html|head|body|title)\b/iu.test(collapsed)) {
    return UNREADABLE_ENGINE_FAILURE_MESSAGE;
  }
  return collapsed.length > FAILURE_MESSAGE_LIMIT
    ? `${collapsed.slice(0, FAILURE_MESSAGE_LIMIT - 1)}\u2026`
    : collapsed;
}

// A runner shutdown transfers ownership of the engine turn to another worker. Unlike a user
// interrupt, it leaves the durable turn available for ACP session recovery in the next worker.
export class CodexChatHandoffError extends Error {
  constructor() {
    super("Codex chat turn is being handed off to another runner.");
    this.name = "CodexChatHandoffError";
  }
}

// The MCP gateway has persisted the exact request. Stop the engine before parking the Run.
export class TaskActionApprovalPauseError extends Error {
  constructor() {
    super("The task is pausing for action approval.");
    this.name = "TaskActionApprovalPauseError";
  }
}
