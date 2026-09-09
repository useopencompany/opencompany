import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { ActionDescriptor } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryActionTurnGovernance, serveActionRequest, summarizeAction } from "./service";

describe("recorded PostHog discovery catalog", () => {
  it("reduces the same catalog without losing any selected schema", async () => {
    const fixture = JSON.parse(
      gunzipSync(
        readFileSync(new URL("./test-fixtures/posthog-discovery.json.gz", import.meta.url)),
      ).toString("utf8"),
    );
    const actions = fixture.actions as ActionDescriptor[];
    expect(createHash("sha256").update(JSON.stringify(actions)).digest("hex")).toBe(
      "c0b12ca98b12a466b306df2141b2d510758af3cd3e05d49b926243719cd9385b",
    );
    const compact = actions.map(summarizeAction);
    expect(compact.map((action) => action.id)).toEqual(actions.map((action) => action.id));
    expect(JSON.stringify(actions).length).toBe(498714);
    expect(JSON.stringify(compact).length).toBe(4205);
    const selected = actions.filter((action) =>
      ["insights-list", "insight-get", "insight-query"].some(
        (id) => action.id === `plugin:posthog:posthog.${id}`,
      ),
    );
    const execute = vi.fn();
    const response = await serveActionRequest({
      request: {
        operation: "describe",
        sessionId: "test",
        turnId: "test",
        actions: selected.map((action) => action.id),
      },
      catalog: { sources: [fixture.source], actions },
      governance: createInMemoryActionTurnGovernance(),
      execute,
    });
    expect(response).toEqual({ ok: true, actions: selected, not_found: [] });
    expect(JSON.stringify(selected).length).toBe(9944);
    expect(JSON.stringify(compact).length + JSON.stringify(selected).length).toBeLessThan(
      JSON.stringify(actions).length * 0.03,
    );
    const largest = actions.reduce((a, b) =>
      JSON.stringify(a).length > JSON.stringify(b).length ? a : b,
    );
    expect(JSON.stringify(largest).length).toBe(111510);
    expect(
      await serveActionRequest({
        request: {
          operation: "describe",
          sessionId: "test",
          turnId: "test",
          actions: [largest.id],
        },
        catalog: { sources: [fixture.source], actions },
        governance: createInMemoryActionTurnGovernance(),
        execute,
      }),
    ).toEqual({ ok: true, actions: [largest], not_found: [] });
    expect(execute).not.toHaveBeenCalled();
  });
});
