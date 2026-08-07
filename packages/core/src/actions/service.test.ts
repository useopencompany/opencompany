import { ACTION_MAX_CALLS_PER_TURN } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  type ActionServiceCatalog,
  createInMemoryActionTurnGovernance,
  serveActionRequest,
} from "./service";

const catalog: ActionServiceCatalog = {
  sources: [{ id: "gmail", label: "Gmail", description: "Email" }],
  actions: [
    {
      id: "gmail.search",
      source: "gmail",
      description: "Search email.",
      params: { type: "object" },
    },
  ],
};

describe("serveActionRequest", () => {
  it("owns discovery, retry-safe identity, and the shared call budget", async () => {
    const governance = createInMemoryActionTurnGovernance();
    const execute = vi.fn(async ({ action }: { action: string }) => ({
      ok: true as const,
      action,
      result: [],
    }));

    await expect(
      serveActionRequest({
        request: executeRequest("before_discovery"),
        catalog,
        governance,
        execute,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid_params" } });

    await expect(
      serveActionRequest({
        request: {
          operation: "list",
          sessionId: "session_1",
          turnId: "turn_1",
          source: "gmail",
        },
        catalog,
        governance,
        execute,
      }),
    ).resolves.toMatchObject({ ok: true, source: { id: "gmail" } });

    for (let call = 1; call <= ACTION_MAX_CALLS_PER_TURN; call += 1) {
      await expect(
        serveActionRequest({
          request: executeRequest(`call_${call}`),
          catalog,
          governance,
          execute,
        }),
      ).resolves.toMatchObject({ ok: true });
    }

    await expect(
      serveActionRequest({
        request: executeRequest("call_17"),
        catalog,
        governance,
        execute,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "call_budget" } });
    expect(execute).toHaveBeenCalledTimes(ACTION_MAX_CALLS_PER_TURN);

    await expect(
      serveActionRequest({
        request: executeRequest("call_1"),
        catalog,
        governance,
        execute,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "duplicate_invocation" } });
    expect(execute).toHaveBeenCalledTimes(ACTION_MAX_CALLS_PER_TURN);
  });

  it("returns the same structured catalog errors to every adapter", async () => {
    await expect(
      serveActionRequest({
        request: {
          operation: "list",
          sessionId: "session_1",
          turnId: "turn_1",
          source: "missing",
        },
        catalog,
        governance: createInMemoryActionTurnGovernance(),
        execute: vi.fn(),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "unknown_source",
        message: 'Unknown source "missing". Use an exact id returned by list_actions.',
        availableSources: ["gmail"],
      },
    });
  });
});

function executeRequest(invocationId: string) {
  return {
    operation: "execute" as const,
    sessionId: "session_1",
    turnId: "turn_1",
    action: "gmail.search",
    params: {},
    invocationId,
  };
}
