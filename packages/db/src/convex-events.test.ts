import { describe, expect, it } from "vitest";
import {
  convexFunctionFailureGroups,
  convexFunctionFailures,
  convexFunctionTypeScope,
  convexWorkflowEventContext,
} from "./convex-events";

const CONVEX_METADATA = {
  deployment_name: "happy-otter-123",
  deployment_type: "prod",
  project_name: "northwind",
  project_slug: "northwind",
};

function failureEvent(overrides: Record<string, unknown> = {}) {
  return {
    topic: "function_execution",
    timestamp: 1_764_600_000_000,
    convex: CONVEX_METADATA,
    function: { path: "messages:send", type: "mutation", request_id: "d064ef901f7ec0b7" },
    status: "failure",
    error_message:
      "Uncaught Error: Cannot read properties of undefined\n  at handler (../convex/messages.ts:12:3)",
    execution_time_ms: 42,
    run_reason: "webSocket",
    ...overrides,
  };
}

describe("convexFunctionFailures", () => {
  it("keeps failed function executions and drops everything else in the batch", () => {
    const failures = convexFunctionFailures([
      { topic: "verification", timestamp: 1_764_600_000_000, message: "Log stream is working" },
      failureEvent({ status: "success", error_message: undefined }),
      { topic: "console", timestamp: 1_764_600_000_000, log_level: "ERROR", message: "'boom'" },
      failureEvent(),
    ]);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      functionPath: "messages:send",
      functionType: "mutation",
      requestId: "d064ef901f7ec0b7",
      runReason: "webSocket",
      deploymentName: "happy-otter-123",
      deploymentType: "prod",
    });
    expect(failures[0]?.at).toEqual(new Date(1_764_600_000_000));
  });

  it("drops a failure it cannot name, and a payload that is not an array", () => {
    expect(convexFunctionFailures(failureEvent())).toEqual([]);
    expect(convexFunctionFailures([failureEvent({ function: { type: "query" } })])).toEqual([]);
    expect(convexFunctionFailures([failureEvent({ timestamp: "nope" })])).toEqual([]);
  });

  it("carries the write-conflict and scheduler detail that explains the failure", () => {
    const [failure] = convexFunctionFailures([
      failureEvent({
        occ_info: {
          table_name: "messages",
          document_id: "k12345678901234567890123456789012",
          write_source: "messages:list",
          retry_count: 4,
        },
        scheduler_info: { job_id: "job_1" },
      }),
    ]);

    expect(failure?.occ).toEqual({
      tableName: "messages",
      documentId: "k12345678901234567890123456789012",
      writeSource: "messages:list",
      retryCount: 4,
    });
    expect(failure?.schedulerJobId).toBe("job_1");
  });
});

describe("convexFunctionFailureGroups", () => {
  it("collapses repeat failures of the same function and error into one delivery", () => {
    const failures = convexFunctionFailures([
      failureEvent(),
      failureEvent({
        timestamp: 1_764_600_001_000,
        function: { path: "messages:send", type: "mutation", request_id: "other" },
      }),
      failureEvent({ timestamp: 1_764_600_002_000 }),
    ]);

    const [group, ...rest] = convexFunctionFailureGroups(failures);

    expect(rest).toEqual([]);
    expect(group?.failureCount).toBe(3);
    // The earliest failure is what describes when the incident started.
    expect(group?.eventAt).toEqual(new Date(1_764_600_000_000));
  });

  it("separates different functions and different errors", () => {
    const groups = convexFunctionFailureGroups(
      convexFunctionFailures([
        failureEvent(),
        failureEvent({ function: { path: "messages:list", type: "query", request_id: "a" } }),
        failureEvent({ error_message: "Uncaught ConvexError: rate limited" }),
      ]),
    );

    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((group) => group.deliveryId)).size).toBe(3);
  });

  it("groups failures whose message differs only in ids and numbers", () => {
    const groups = convexFunctionFailureGroups(
      convexFunctionFailures([
        failureEvent({ error_message: "Uncaught Error: document jd71abcdefghijklmnop not found" }),
        failureEvent({ error_message: "Uncaught Error: document jd72zyxwvutsrqponml not found" }),
      ]),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.failureCount).toBe(2);
  });

  it("keys the delivery id on the failure's own window, so a redelivered batch is a no-op", () => {
    const first = convexFunctionFailureGroups(convexFunctionFailures([failureEvent()]));
    const redelivered = convexFunctionFailureGroups(convexFunctionFailures([failureEvent()]));

    expect(redelivered[0]?.deliveryId).toBe(first[0]?.deliveryId);

    const nextWindow = convexFunctionFailureGroups(
      convexFunctionFailures([failureEvent({ timestamp: 1_764_600_000_000 + 15 * 60 * 1000 })]),
    );
    expect(nextWindow[0]?.deliveryId).not.toBe(first[0]?.deliveryId);
  });

  it("ranks groups loudest first so a caller capping the list keeps what matters", () => {
    const failures = convexFunctionFailures(
      Array.from({ length: 25 }, (_, index) =>
        failureEvent({
          function: { path: `messages:fn${index}`, type: "query", request_id: `r${index}` },
        }),
      ).concat(
        // One function fails twice, so it must sort ahead of the ones that failed once.
        failureEvent({ function: { path: "messages:fn3", type: "query", request_id: "again" } }),
      ),
    );

    const groups = convexFunctionFailureGroups(failures);

    // Grouping itself is uncapped: the per-route cap belongs to the caller, which applies it after
    // filter matching so a filtered trigger cannot lose its incident to noisier groups.
    expect(groups).toHaveLength(25);
    expect(groups[0]?.failure.functionPath).toBe("messages:fn3");
    expect(groups[0]?.failureCount).toBe(2);
    expect(groups.slice(1).every((group) => group.failureCount === 1)).toBe(true);
  });
});

describe("convexWorkflowEventContext", () => {
  it("describes the incident with what a triage agent needs to start", () => {
    const [group] = convexFunctionFailureGroups(
      convexFunctionFailures([
        failureEvent(),
        failureEvent({ timestamp: 1_764_600_001_000 }),
        failureEvent({
          timestamp: 1_764_600_002_000,
          occ_info: { table_name: "messages", write_source: "messages:list", retry_count: 4 },
        }),
      ]),
    );
    const context = convexWorkflowEventContext(group!);
    const body = context.lines.filter((line) => line !== null).join("\n");

    expect(context.tag).toBe("convex_function_failure");
    expect(body).toContain("Deployment: happy-otter-123 (prod)");
    expect(body).toContain("Function: messages:send (mutation)");
    expect(body).toContain("Request id: d064ef901f7ec0b7");
    expect(body).toContain("3 failures of this function");
    expect(body).toContain("Cannot read properties of undefined");
  });
});

describe("convexFunctionTypeScope", () => {
  it("matches the filter option ids the Convex package declares", () => {
    const [httpAction] = convexFunctionFailures([
      failureEvent({ function: { path: "POST /stripe", type: "http_action", request_id: "a" } }),
    ]);

    expect(convexFunctionTypeScope(httpAction!)).toBe("http_action");
  });
});
