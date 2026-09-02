import type { ActionGatewayResponse, ActionHostGatewayRequest } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { createActionDispatcher } from "./opencompany-action-gateway";

describe("createActionDispatcher", () => {
  it("loads the host-authorized catalog and durably dispatches an interactive action", async () => {
    const requests: ActionHostGatewayRequest[] = [];
    const execute = vi.fn(async ({ request }: { request: ActionHostGatewayRequest }) => {
      requests.push(request);
      const response: ActionGatewayResponse =
        request.operation === "catalog"
          ? {
              ok: true,
              catalog: {
                sources: [
                  { id: "gmail", kind: "integration", label: "Gmail", description: "Email" },
                ],
                actions: [
                  {
                    id: "gmail.send",
                    source: "gmail",
                    description: "Send email.",
                    params: { type: "object" },
                    permissionMode: "ask",
                  },
                ],
              },
            }
          : request.operation === "approval"
            ? { ok: true, needsApproval: true }
            : request.operation === "list"
              ? {
                  ok: true,
                  source: {
                    id: "gmail",
                    kind: "integration",
                    label: "Gmail",
                    description: "Email",
                  },
                  actions: [],
                }
              : { ok: true, action: request.action, result: { sent: true } };
      return response;
    });

    const dispatcher = await createActionDispatcher(context(), {
      execute,
    });

    expect(dispatcher?.catalog.actions).toEqual([
      expect.objectContaining({ id: "gmail.send", permissionMode: "ask" }),
    ]);
    await expect(
      dispatcher?.needsApproval?.({
        action: "gmail.send",
        params: { to: "ada@example.com" },
        toolCallId: "call_1",
      }),
    ).resolves.toBe(true);
    await expect(
      dispatcher?.execute({
        action: "gmail.send",
        params: { to: "ada@example.com" },
        toolCallId: "call_1",
      }),
    ).resolves.toEqual({ ok: true, action: "gmail.send", result: { sent: true } });

    expect(requests.map((request) => request.operation)).toEqual([
      "catalog",
      "approval",
      "list",
      "execute",
    ]);
    expect(requests.at(-1)).toMatchObject({
      sessionId: "session_1",
      turnId: "turn_1",
      invocationId: "call_1",
    });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("prelists the recovered catalog only for an approval continuation", async () => {
    const execute = vi.fn(
      async () =>
        ({
          ok: true,
          catalog: {
            sources: [{ id: "plugin:slack:slack", label: "Slack", description: "Messages" }],
            actions: [
              {
                id: "plugin:slack:slack.post",
                source: "plugin:slack:slack",
                description: "Post a message.",
                params: { type: "object" },
                permissionMode: "ask",
              },
            ],
          },
        }) satisfies ActionGatewayResponse,
    );

    const dispatcher = await createActionDispatcher(
      { ...context(), approvalContinuation: true },
      { execute },
    );

    expect(dispatcher?.prelistedSourceIds).toEqual(["plugin:slack:slack"]);
  });

  it("treats an empty authorized catalog as a valid Chat runtime", async () => {
    const execute = vi.fn(
      async () =>
        ({
          ok: true,
          catalog: { sources: [], actions: [] },
        }) satisfies ActionGatewayResponse,
    );

    const dispatcher = await createActionDispatcher(context(), {
      execute,
    });

    expect(dispatcher).not.toBeNull();
    expect(dispatcher?.catalog).toEqual({ sources: [], actions: [] });
  });

  it("returns a model-visible tool error when action approval cannot be evaluated", async () => {
    const execute = vi.fn(
      async ({ request }: { request: ActionHostGatewayRequest }): Promise<ActionGatewayResponse> =>
        request.operation === "catalog"
          ? {
              ok: true,
              catalog: {
                sources: [{ id: "gmail", label: "Gmail", description: "Email" }],
                actions: [
                  {
                    id: "gmail.send",
                    source: "gmail",
                    description: "Send email.",
                    params: { type: "object" },
                    permissionMode: "ask",
                  },
                ],
              },
            }
          : { ok: false, error: { code: "internal", message: "Unavailable." } },
    );
    const dispatcher = await createActionDispatcher(context(), {
      execute,
    });

    await expect(
      dispatcher?.needsApproval?.({
        action: "gmail.send",
        params: { to: "ada@example.com" },
        toolCallId: "call_1",
      }),
    ).resolves.toBe(false);
    await expect(
      dispatcher?.execute({
        action: "gmail.send",
        params: { to: "ada@example.com" },
        toolCallId: "call_1",
      }),
    ).resolves.toEqual({
      ok: false,
      action: "gmail.send",
      error: {
        code: "internal",
        source: "gmail",
        message: 'Approval for "gmail.send" could not be evaluated, so the action was not run.',
      },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not require a reachable web origin", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("web unavailable"));
    const dispatcher = await createActionDispatcher(context(), {
      execute: async () => ({ ok: true, catalog: { sources: [], actions: [] } }),
    });

    expect(dispatcher).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

function context() {
  return {
    sessionId: "session_1",
    turnId: "turn_1",
    signal: new AbortController().signal,
    approvalContinuation: false,
  };
}
