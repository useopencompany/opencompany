export class GoatCodexChatLeaseLostError extends Error {
  constructor() {
    super("Codex chat turn lease is no longer owned by this worker.");
    this.name = "GoatCodexChatLeaseLostError";
  }
}

// A task can become terminal after its durable turn is queued but before the engine starts. This
// is distinct from losing the turn lease: the current worker still owns the turn and must settle
// it immediately instead of leaving it running until lease expiry.
export class GoatTaskTurnTerminalError extends Error {
  constructor() {
    super("Goat task is already terminal.");
    this.name = "GoatTaskTurnTerminalError";
  }
}

// Transient provider failures before Codex starts must preserve the durable user turn. The worker
// catches this error and defers the same leased row with backoff instead of projecting a failed
// assistant message.
export class GoatCodexChatRetryableInfrastructureError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "GoatCodexChatRetryableInfrastructureError";
    this.cause = cause;
  }
}

// A runner shutdown transfers observation of the Codex turn to another worker. Unlike a user
// interrupt, this must only detach the app-server proxy: the turn itself keeps running in E2B.
export class GoatCodexChatHandoffError extends Error {
  constructor() {
    super("Codex chat turn is being handed off to another runner.");
    this.name = "GoatCodexChatHandoffError";
  }
}
