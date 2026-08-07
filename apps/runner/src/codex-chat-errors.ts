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
    super("Task is already terminal.");
    this.name = "TaskTurnTerminalError";
  }
}

// Transient provider failures must preserve the durable user turn. Before an engine starts, the
// worker retries the same turn from scratch. After the engine boundary, the next claim uses the
// persisted recovery state to fence any leftover process and resume safely instead of projecting a
// failed assistant message.
export class CodexChatRetryableInfrastructureError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "CodexChatRetryableInfrastructureError";
    this.cause = cause;
  }
}

// A runner shutdown transfers observation of the Codex turn to another worker. Unlike a user
// interrupt, this must only detach the app-server proxy: the turn itself keeps running in E2B.
export class CodexChatHandoffError extends Error {
  constructor() {
    super("Codex chat turn is being handed off to another runner.");
    this.name = "CodexChatHandoffError";
  }
}
