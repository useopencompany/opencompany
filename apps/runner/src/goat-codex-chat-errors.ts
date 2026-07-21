export class GoatCodexChatLeaseLostError extends Error {
  constructor() {
    super("Codex chat turn lease is no longer owned by this worker.");
    this.name = "GoatCodexChatLeaseLostError";
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
