import type {
  GoatActionGatewayResponse,
  GoatActionHostGatewayRequest,
} from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { createGoatOpenCompanyActionDispatcher } from "./goat-opencompany-action-gateway";

describe("createGoatOpenCompanyActionDispatcher", () => {
  it("loads the host-authorized catalog and durably dispatches an interactive action", async () => {
    const requests: GoatActionHostGatewayRequest[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as GoatActionHostGatewayRequest;
      requests.push(request);
      const response: GoatActionGatewayResponse =
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
      return Response.json(response);
    });

    const dispatcher = await createGoatOpenCompanyActionDispatcher(context(), {
      fetch: fetch as typeof globalThis.fetch,
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
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer runner-secret",
    });
  });

  it("prelists the recovered catalog only for an approval continuation", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        catalog: {
          sources: [{ id: "slack", label: "Slack", description: "Messages" }],
          actions: [
            {
              id: "slack.post",
              source: "slack",
              description: "Post a message.",
              params: { type: "object" },
              permissionMode: "ask",
            },
          ],
        },
      } satisfies GoatActionGatewayResponse),
    );

    const dispatcher = await createGoatOpenCompanyActionDispatcher(
      { ...context(), approvalContinuation: true },
      { fetch: fetch as typeof globalThis.fetch },
    );

    expect(dispatcher?.prelistedSourceIds).toEqual(["slack"]);
  });

  it("treats an empty authorized catalog as a valid Chat runtime", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        catalog: { sources: [], actions: [] },
      } satisfies GoatActionGatewayResponse),
    );

    const dispatcher = await createGoatOpenCompanyActionDispatcher(context(), {
      fetch: fetch as typeof globalThis.fetch,
    });

    expect(dispatcher).not.toBeNull();
    expect(dispatcher?.catalog).toEqual({ sources: [], actions: [] });
  });

  it("fails closed when action approval cannot be evaluated", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as GoatActionHostGatewayRequest;
      return Response.json(
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
    });
    const dispatcher = await createGoatOpenCompanyActionDispatcher(context(), {
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(
      dispatcher?.needsApproval?.({
        action: "gmail.send",
        params: { to: "ada@example.com" },
        toolCallId: "call_1",
      }),
    ).rejects.toThrow("Action approval could not be evaluated.");
  });

  it("fails closed when the internal gateway is not configured", async () => {
    await expect(
      createGoatOpenCompanyActionDispatcher({
        ...context(),
        env: { goatAppUrl: undefined, internalToken: "runner-secret" },
      }),
    ).resolves.toBeNull();
  });
});

function context() {
  return {
    sessionId: "session_1",
    turnId: "turn_1",
    env: {
      goatAppUrl: "https://app.example.com",
      internalToken: "runner-secret",
    },
    signal: new AbortController().signal,
    approvalContinuation: false,
  };
}
