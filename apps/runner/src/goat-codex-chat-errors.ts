export class GoatCodexChatLeaseLostError extends Error {
  constructor() {
    super("Codex chat turn lease is no longer owned by this worker.");
    this.name = "GoatCodexChatLeaseLostError";
  }
}
