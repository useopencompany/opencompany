import { afterEach, describe, expect, it, vi } from "vitest";
import { executeApiWorkflowCommand } from "./api-workflow-client";

const input = {
  origin: "http://api.local",
  token: "test-token",
  actorId: "user_1",
  workspaceId: "workspace_1",
  toolInput: { command: "create", name: "Draft" },
  idempotencyKey: "workflow:turn:call",
};
describe("workflow API client", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("forwards identity and preserves recoverable partial failures", async () => {
    const result = {
      ok: false,
      partial: true,
      error: "Invalid schedule",
      workflow: { id: "workflow_1", status: "draft" },
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: result })));
    vi.stubGlobal("fetch", fetch);
    expect(await executeApiWorkflowCommand(input)).toEqual(result);
    expect(fetch).toHaveBeenCalledWith(
      "http://api.local/internal/workflows/commands",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
          "idempotency-key": input.idempotencyKey,
        }),
        body: JSON.stringify({
          userWorkosId: input.actorId,
          workspaceId: input.workspaceId,
          command: input.toolInput,
        }),
      }),
    );
  });
  it("does not retry a failed transport write or expose raw errors", async () => {
    const fetch = vi.fn(async () => new Response("Sensitive upstream body", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(executeApiWorkflowCommand(input)).rejects.toThrow(
      "Workflow command failed (HTTP 503)",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
});
