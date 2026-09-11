import { ACTION_MAX_CALLS_PER_TURN } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  type ActionServiceCatalog,
  createInMemoryActionTurnGovernance,
  serveActionRequest,
  summarizeAction,
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

  it("reports admitted calls and rejects a concurrent batch beyond the shared cap", async () => {
    const governance = createInMemoryActionTurnGovernance({ prelistedSourceIds: ["gmail"] });
    const execute = vi.fn(async () => ({ ok: true as const, action: "gmail.search", result: [] }));
    const results = await Promise.all(
      Array.from({ length: 23 }, (_, i) =>
        serveActionRequest({
          request: executeRequest(`parallel-${i}`),
          catalog,
          governance,
          execute,
        }),
      ),
    );
    expect(execute).toHaveBeenCalledTimes(16);
    expect(
      results.filter((result) => !result.ok && result.error.code === "call_budget"),
    ).toHaveLength(7);
    expect(results[0]?.budget).toEqual({ limit: 16, used: 1, remaining: 15 });
    expect(results[15]?.budget).toEqual({ limit: 16, used: 16, remaining: 0 });
    expect(results[22]?.budget).toEqual({ limit: 16, used: 16, remaining: 0 });
  });

  it("preserves the host budget across a fresh wrapper after approval resume", async () => {
    const host = createInMemoryActionTurnGovernance({ prelistedSourceIds: ["gmail"] });
    const execute = vi.fn(async () => ({ ok: true as const, action: "gmail.search", result: [] }));
    const call = (id: string) =>
      serveActionRequest({
        request: executeRequest(id),
        catalog,
        governance: createInMemoryActionTurnGovernance({ prelistedSourceIds: ["gmail"] }),
        execute: () =>
          serveActionRequest({ request: executeRequest(id), catalog, governance: host, execute }),
      });
    for (let i = 0; i < 16; i++) await call(`resume-${i}`);
    expect(await call("resume-16")).toMatchObject({
      ok: false,
      error: { code: "call_budget" },
      budget: { limit: 16, used: 16, remaining: 0 },
    });
    expect(await call("resume-0")).toMatchObject({
      ok: false,
      error: { code: "duplicate_invocation" },
      budget: { limit: 16, used: 16, remaining: 0 },
    });
    expect(execute).toHaveBeenCalledTimes(16);
  });

  it("charges admitted invalid parameters and provider failures, but not unknown actions", async () => {
    const governance = createInMemoryActionTurnGovernance({ prelistedSourceIds: ["gmail"] });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "invalid_params", message: "Missing query" },
      })
      .mockResolvedValueOnce({ ok: false, error: { code: "timeout", message: "Timed out" } });
    await serveActionRequest({
      request: { ...executeRequest("unknown"), action: "missing" },
      catalog,
      governance,
      execute,
    });
    for (let i = 1; i <= 2; i++) {
      expect(
        await serveActionRequest({
          request: executeRequest(`failure-${i}`),
          catalog,
          governance,
          execute,
        }),
      ).toMatchObject({ ok: false, budget: { limit: 16, used: i, remaining: 16 - i } });
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps the failure cap and identifies opencompany as the owner of the limit", async () => {
    const governance = createInMemoryActionTurnGovernance();
    await governance.recordSourceDiscovery("gmail");
    const execute = vi.fn(async () => ({
      ok: false as const,
      error: { code: "provider_error", message: "HTTP 503" },
    }));
    let result;
    for (let i = 0; i < 3; i++)
      result = await serveActionRequest({
        request: executeRequest(`failure-${i}`),
        catalog,
        governance,
        execute,
      });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "provider_error",
        message: expect.stringContaining("This limit is enforced by opencompany"),
      },
    });
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

describe("compact action discovery", () => {
  const fullAction = {
    ...catalog.actions[0]!,
    description: `  Search\n email. ${"Long description ".repeat(40)}`,
    params: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string", description: "Complete schema".repeat(1000) } },
    },
    permissionMode: "ask" as const,
  };
  const fullCatalog = { ...catalog, actions: [fullAction, { ...fullAction, id: "gmail.read" }] };
  const request = { sessionId: "session", turnId: "turn" };

  it("lists all IDs in catalog order with bounded previews and no schemas", async () => {
    const result = await serveActionRequest({
      request: { ...request, operation: "list", source: "gmail" },
      catalog: fullCatalog,
      governance: createInMemoryActionTurnGovernance(),
      execute: vi.fn(),
    });
    expect(result).toMatchObject({
      ok: true,
      actions: [{ id: "gmail.search", permissionMode: "ask" }, { id: "gmail.read" }],
    });
    if (!result.ok || !("actions" in result)) throw new Error("Expected inventory");
    for (const action of result.actions) {
      expect(action).not.toHaveProperty("params");
      expect(action.description.length).toBeLessThanOrEqual(160);
      expect(action.description).toMatch(/^Search email\. .+…$/);
    }
    expect(
      summarizeAction({ ...fullAction, description: " Short\n description. " }).description,
    ).toBe("Short description.");
  });

  it("preserves complete definitions and legacy listing payloads exactly", async () => {
    const governance = createInMemoryActionTurnGovernance();
    const execute = vi.fn();
    const description = await serveActionRequest({
      request: {
        ...request,
        operation: "describe",
        actions: [fullAction.id, "missing", fullAction.id, "missing", "gmail.read"],
      },
      catalog: fullCatalog,
      governance,
      execute,
    });
    expect(description).toEqual({ ok: true, actions: fullCatalog.actions, not_found: ["missing"] });
    expect(governance.hasDiscoveredSource?.("gmail")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const legacy = await serveActionRequest({
      request: { ...request, operation: "list", source: "gmail" },
      catalog: fullCatalog,
      governance,
      execute,
      legacyDiscovery: true,
    });
    expect(legacy).toMatchObject({ actions: fullCatalog.actions });
  });

  it.each([
    undefined,
    null,
    "gmail.search",
    [],
    [""],
    ["  "],
    [1],
    [null],
    Array(6).fill("gmail.search"),
  ])("rejects malformed batches before any discovery: %j", async (actions) => {
    const governance = { recordSourceDiscovery: vi.fn(), claimInvocation: vi.fn() };
    const execute = vi.fn();
    expect(
      await serveActionRequest({
        request: { ...request, operation: "describe", actions: actions as string[] },
        catalog: fullCatalog,
        governance,
        execute,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(governance.recordSourceDiscovery).not.toHaveBeenCalled();
    expect(governance.claimInvocation).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses exact IDs, records only found sources, and leaves all 16 executions available", async () => {
    const governance = createInMemoryActionTurnGovernance();
    const execute = vi.fn(async ({ action }: { action: string }) => ({
      ok: true as const,
      action,
      result: [],
    }));
    expect(
      await serveActionRequest({
        request: {
          ...request,
          operation: "describe",
          actions: ["GMAIL.SEARCH", " gmail.search", "unavailable"],
        },
        catalog,
        governance,
        execute,
      }),
    ).toEqual({
      ok: true,
      actions: [],
      not_found: ["GMAIL.SEARCH", " gmail.search", "unavailable"],
    });
    expect(governance.hasDiscoveredSource?.("gmail")).toBe(false);
    for (let i = 0; i < 20; i++) {
      await serveActionRequest({
        request: { ...request, operation: "describe", actions: ["gmail.search"] },
        catalog,
        governance,
        execute,
      });
    }
    for (let i = 0; i < 16; i++) {
      expect(
        await serveActionRequest({
          request: executeRequest(String(i)),
          catalog,
          governance,
          execute,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(execute).toHaveBeenCalledTimes(16);
    expect(
      await serveActionRequest({ request: executeRequest("17"), catalog, governance, execute }),
    ).toMatchObject({ ok: false, error: { code: "call_budget" } });
  });
});
