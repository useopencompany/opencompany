import { GOAT_ACTION_MAX_CALLS_PER_TURN } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryGoatActionTurnGovernance,
  type GoatActionServiceCatalog,
  serveGoatActionRequest,
} from "./service";

const catalog: GoatActionServiceCatalog = {
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

describe("serveGoatActionRequest", () => {
  it("owns discovery, retry-safe identity, and the shared call budget", async () => {
    const governance = createInMemoryGoatActionTurnGovernance();
    const execute = vi.fn(async ({ action }: { action: string }) => ({
      ok: true as const,
      action,
      result: [],
    }));

    await expect(
      serveGoatActionRequest({
        request: executeRequest("before_discovery"),
        catalog,
        governance,
        execute,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid_params" } });

    await expect(
      serveGoatActionRequest({
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

    for (let call = 1; call <= GOAT_ACTION_MAX_CALLS_PER_TURN; call += 1) {
      await expect(
        serveGoatActionRequest({
          request: executeRequest(`call_${call}`),
          catalog,
          governance,
          execute,
        }),
      ).resolves.toMatchObject({ ok: true });
    }

    await expect(
      serveGoatActionRequest({
        request: executeRequest("call_17"),
        catalog,
        governance,
        execute,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "call_budget" } });
    expect(execute).toHaveBeenCalledTimes(GOAT_ACTION_MAX_CALLS_PER_TURN);

    await expect(
      serveGoatActionRequest({
        request: executeRequest("call_1"),
        catalog,
        governance,
        execute,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "duplicate_invocation" } });
    expect(execute).toHaveBeenCalledTimes(GOAT_ACTION_MAX_CALLS_PER_TURN);
  });

  it("returns the same structured catalog errors to every adapter", async () => {
    await expect(
      serveGoatActionRequest({
        request: {
          operation: "list",
          sessionId: "session_1",
          turnId: "turn_1",
          source: "missing",
        },
        catalog,
        governance: createInMemoryGoatActionTurnGovernance(),
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
