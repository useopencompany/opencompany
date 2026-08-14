import type { BrainIngestJobReadModel, BrainSourceItemDto } from "@opencompany/protocol";
import { describe, expect, it } from "vitest";
import { buildBrainActivityEvents, buildBrainDraftIngestStates } from "@/lib/brain-activity";

function job(overrides: Partial<BrainIngestJobReadModel> = {}): BrainIngestJobReadModel {
  return {
    id: "gbjob_1",
    sourceItemId: "gbsrc_1",
    sourceProvider: "goat-chat",
    kind: "brain_agent_ingest",
    status: "queued",
    planPaused: false,
    attempts: 0,
    lastError: null,
    result: {},
    completedAt: null,
    createdAt: "2026-07-09T10:00:00.000Z",
    updatedAt: "2026-07-09T10:00:00.000Z",
    ...overrides,
  };
}

function item(overrides: Partial<BrainSourceItemDto> = {}): BrainSourceItemDto {
  return {
    id: "gbsrc_1",
    sourceProvider: "goat-chat",
    sourceType: "capture",
    externalId: "pricing-reference",
    title: "Pricing teardown reference",
    occurredAt: "2026-07-09T10:00:00.000Z",
    capturedAt: "2026-07-09T10:00:00.000Z",
    lastIngestStatus: "pending",
    lastIngestError: null,
    createdAt: "2026-07-09T10:00:00.000Z",
    updatedAt: "2026-07-09T10:00:00.000Z",
    ...overrides,
  };
}

describe("buildBrainActivityEvents", () => {
  it("emits a capture event for a queued chat capture", () => {
    const events = buildBrainActivityEvents([job()], [item()]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      traceId: "gbjob_1",
      kind: "captured",
      title: "Captured to inbox",
      sourceTitle: "Pricing teardown reference",
      at: "2026-07-09T10:00:00.000Z",
    });
  });

  it("shows queued work held by a quota reservation as paused by plan", () => {
    const events = buildBrainActivityEvents([job({ planPaused: true })], [item()]);

    expect(events.find((event) => event.kind === "paused")).toMatchObject({
      kind: "paused",
      title: "Paused by plan",
    });
  });

  it("labels meeting sources and adds a filing event while running", () => {
    const events = buildBrainActivityEvents(
      [job({ status: "running", updatedAt: "2026-07-09T10:00:30.000Z" })],
      [item({ sourceProvider: "jamie", sourceType: "meeting", title: "Roadmap review" })],
    );

    expect(events.map((event) => event.kind)).toEqual(["filing", "captured"]);
    expect(events[1]).toMatchObject({ title: "Meeting received", sourceTitle: "Roadmap review" });
    expect(events[0]).toMatchObject({ traceId: "gbjob_1", title: "Filing into brain…" });
  });

  it("summarizes a succeeded job with the result's first line and brain id", () => {
    const events = buildBrainActivityEvents(
      [
        job({
          status: "succeeded",
          completedAt: "2026-07-09T10:01:20.000Z",
          result: {
            summary: "Promoted the capture into concepts.\n\nDetails follow.",
            draftBrainId: "pricing-teardown-reference",
            pages: [
              {
                brainId: "pricing-teardown",
                folderPath: "concepts",
                title: "Pricing teardown",
                action: "created",
              },
              {
                brainId: "acme",
                folderPath: "companies",
                title: "Acme",
                action: "updated",
              },
              { brainId: "", folderPath: "companies", title: "Broken", action: "created" },
              { brainId: "ignored", folderPath: "companies", title: "Ignored", action: "bad" },
              "not a page",
            ],
          },
        }),
      ],
      [item()],
    );

    const filed = events.find((event) => event.kind === "filed");
    expect(filed).toMatchObject({
      at: "2026-07-09T10:01:20.000Z",
      detail: "Promoted the capture into concepts.",
      brainId: "pricing-teardown-reference",
      durationMs: 80_000,
      pages: [
        {
          brainId: "pricing-teardown",
          folderPath: "concepts",
          title: "Pricing teardown",
          action: "created",
        },
        {
          brainId: "acme",
          folderPath: "companies",
          title: "Acme",
          action: "updated",
        },
      ],
    });
  });

  it("falls back to an empty page list for legacy succeeded jobs", () => {
    const events = buildBrainActivityEvents(
      [
        job({
          status: "succeeded",
          result: {
            summary: "Filed.",
            draftBrainId: "pricing-reference",
          },
        }),
      ],
      [item()],
    );

    expect(events.find((event) => event.kind === "filed")).toMatchObject({ pages: [] });
  });

  it("attaches valid completed traces and ignores malformed legacy traces", () => {
    const events = buildBrainActivityEvents(
      [
        job({
          id: "gbjob_traced",
          status: "succeeded",
          completedAt: "2026-07-09T10:01:20.000Z",
          result: {
            skipped: true,
            summary: "No durable brain material.",
            durationMs: 72_000,
            trace: trace(),
          },
        }),
        job({
          id: "gbjob_legacy",
          status: "succeeded",
          completedAt: "2026-07-09T10:01:10.000Z",
          result: {
            summary: "Filed.",
            trace: { schemaVersion: "old" },
          },
        }),
      ],
      [item()],
    );

    const traced = events.find((event) => event.id === "gbjob_traced:skipped");
    const legacy = events.find((event) => event.id === "gbjob_legacy:filed");
    expect(traced).toMatchObject({
      kind: "skipped",
      title: "Skipped filing",
      trace: {
        schemaVersion: "goat.brain_ingest_trace.v1",
        toolCallCount: 1,
      },
      durationMs: 72_000,
    });
    expect(legacy).toMatchObject({ trace: null });
  });

  it("shows first-class skipped jobs as skipped filing events", () => {
    const events = buildBrainActivityEvents(
      [
        job({
          status: "skipped",
          completedAt: "2026-07-09T10:01:20.000Z",
          lastError: "routine_linear_status_change",
          result: {
            skipped: true,
            reason: "routine_linear_status_change",
            summary: "SKIP",
          },
        }),
      ],
      [item({ sourceProvider: "linear", sourceType: "issue", title: "G-51 add github" })],
    );

    expect(events.find((event) => event.kind === "skipped")).toMatchObject({
      title: "Skipped filing",
      detail: "SKIP",
      sourceTitle: "G-51 add github",
    });
  });

  it("reports failures and retries with the last error", () => {
    const failed = buildBrainActivityEvents(
      [job({ status: "failed", attempts: 5, lastError: "Gateway timed out." })],
      [item()],
    );
    expect(failed.find((event) => event.kind === "failed")).toMatchObject({
      title: "Filing failed after 5 attempts",
      detail: "Gateway timed out.",
    });

    const retrying = buildBrainActivityEvents(
      [job({ status: "queued", attempts: 2, lastError: "Brain changed while running." })],
      [item()],
    );
    expect(retrying.find((event) => event.kind === "retrying")).toMatchObject({
      title: "Filing failed — will retry",
      detail: "Brain changed while running.",
    });
  });

  it("sorts newest first and tolerates a missing source item", () => {
    const events = buildBrainActivityEvents(
      [
        job({
          id: "gbjob_old",
          sourceItemId: "gbsrc_missing",
          createdAt: "2026-07-09T09:00:00.000Z",
        }),
        job({ id: "gbjob_new", createdAt: "2026-07-09T11:00:00.000Z" }),
      ],
      [item()],
    );

    expect(events.map((event) => event.id)).toEqual(["gbjob_new:captured", "gbjob_old:captured"]);
    expect(events[1]?.sourceTitle).toBe("Untitled");
  });
});

function trace() {
  return {
    schemaVersion: "goat.brain_ingest_trace.v1",
    model: "anthropic/claude-sonnet-5",
    steps: 2,
    toolCallCount: 1,
    mutations: 0,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    finalText: "No durable brain material.",
    toolCalls: [
      {
        id: "goat_brain_call_1",
        toolName: "goat_brain",
        command: "query",
        args: ["Pricing"],
        stdinPreview: null,
        status: "completed",
        mutating: false,
        exitCode: 0,
        stdoutPreview: "[]",
        stderrPreview: "",
        errorPreview: "",
        startedAt: "2026-07-09T10:00:00.000Z",
        completedAt: "2026-07-09T10:00:01.000Z",
      },
    ],
    truncatedToolCalls: 0,
    createdAt: "2026-07-09T10:00:02.000Z",
  };
}

describe("buildBrainDraftIngestStates", () => {
  it("maps pending chat capture jobs to their inbox draft id", () => {
    const states = buildBrainDraftIngestStates([job()], [item()]);

    expect(states.get("pricing-reference")).toMatchObject({
      kind: "queued",
      jobId: "gbjob_1",
      title: "Pricing teardown reference",
      attempts: 0,
    });
  });

  it("uses running, retrying, and failed job states", () => {
    const running = buildBrainDraftIngestStates(
      [job({ status: "running", attempts: 1 })],
      [item()],
    );
    expect(running.get("pricing-reference")).toMatchObject({ kind: "running", attempts: 1 });

    const retrying = buildBrainDraftIngestStates(
      [job({ status: "queued", attempts: 2, lastError: "Brain changed while running." })],
      [item()],
    );
    expect(retrying.get("pricing-reference")).toMatchObject({
      kind: "retrying",
      detail: "Brain changed while running.",
    });

    const failed = buildBrainDraftIngestStates(
      [job({ status: "failed", attempts: 5, lastError: "Gateway timed out." })],
      [item({ lastIngestStatus: "failed" })],
    );
    expect(failed.get("pricing-reference")).toMatchObject({
      kind: "failed",
      detail: "Gateway timed out.",
    });
  });

  it("hides succeeded jobs and ignores non-capture source items", () => {
    expect(buildBrainDraftIngestStates([job({ status: "succeeded" })], [item()]).size).toBe(0);
    expect(
      buildBrainDraftIngestStates(
        [job({ sourceProvider: "jamie" })],
        [item({ sourceProvider: "jamie", sourceType: "meeting" })],
      ).size,
    ).toBe(0);
  });
});
