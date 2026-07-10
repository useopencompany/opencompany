import { describe, expect, it } from "vitest";
import {
  buildGoatBrainActivityEvents,
  buildGoatBrainDraftIngestStates,
} from "@/lib/brain-activity";
import type { GoatBrainIngestJobRow, GoatBrainSourceItemRow } from "@/lib/task-collections";

function job(overrides: Partial<GoatBrainIngestJobRow> = {}): GoatBrainIngestJobRow {
  return {
    id: "gbjob_1",
    source_item_id: "gbsrc_1",
    user_workos_id: "user_1",
    source_provider: "goat-chat",
    source_connection_id: "session_1",
    integration_id: null,
    brain_ref: "gbrain_1",
    kind: "brain_agent_ingest",
    content_hash: "hash",
    status: "queued",
    attempts: 0,
    next_run_at: "2026-07-09T10:00:00.000Z",
    lease_id: null,
    lease_owner: null,
    lease_expires_at: null,
    last_error: null,
    result: {},
    completed_at: null,
    created_at: "2026-07-09T10:00:00.000Z",
    updated_at: "2026-07-09T10:00:00.000Z",
    ...overrides,
  };
}

function item(overrides: Partial<GoatBrainSourceItemRow> = {}): GoatBrainSourceItemRow {
  return {
    id: "gbsrc_1",
    user_workos_id: "user_1",
    source_provider: "goat-chat",
    source_type: "capture",
    external_id: "pricing-reference",
    title: "Pricing teardown reference",
    occurred_at: "2026-07-09T10:00:00.000Z",
    captured_at: "2026-07-09T10:00:00.000Z",
    content_hash: "hash",
    last_ingest_job_id: "gbjob_1",
    last_ingest_status: "pending",
    last_ingest_error: null,
    last_ingested_at: null,
    created_at: "2026-07-09T10:00:00.000Z",
    updated_at: "2026-07-09T10:00:00.000Z",
    ...overrides,
  };
}

describe("buildGoatBrainActivityEvents", () => {
  it("emits a capture event for a queued chat capture", () => {
    const events = buildGoatBrainActivityEvents([job()], [item()]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      traceId: "gbjob_1",
      kind: "captured",
      title: "Captured to inbox",
      sourceTitle: "Pricing teardown reference",
      at: "2026-07-09T10:00:00.000Z",
    });
  });

  it("labels meeting sources and adds a filing event while running", () => {
    const events = buildGoatBrainActivityEvents(
      [job({ status: "running", updated_at: "2026-07-09T10:00:30.000Z" })],
      [item({ source_provider: "jamie", source_type: "meeting", title: "Roadmap review" })],
    );

    expect(events.map((event) => event.kind)).toEqual(["filing", "captured"]);
    expect(events[1]).toMatchObject({ title: "Meeting received", sourceTitle: "Roadmap review" });
    expect(events[0]).toMatchObject({ traceId: "gbjob_1", title: "Filing into brain…" });
  });

  it("summarizes a succeeded job with the result's first line and brain id", () => {
    const events = buildGoatBrainActivityEvents(
      [
        job({
          status: "succeeded",
          completed_at: "2026-07-09T10:01:20.000Z",
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
    const events = buildGoatBrainActivityEvents(
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
    const events = buildGoatBrainActivityEvents(
      [
        job({
          id: "gbjob_traced",
          status: "succeeded",
          completed_at: "2026-07-09T10:01:20.000Z",
          result: {
            skipped: true,
            summary: "No durable brain material.",
            trace: trace(),
          },
        }),
        job({
          id: "gbjob_legacy",
          status: "succeeded",
          completed_at: "2026-07-09T10:01:10.000Z",
          result: {
            summary: "Filed.",
            trace: { schemaVersion: "old" },
          },
        }),
      ],
      [item()],
    );

    const traced = events.find((event) => event.id === "gbjob_traced:filed");
    const legacy = events.find((event) => event.id === "gbjob_legacy:filed");
    expect(traced).toMatchObject({
      title: "Skipped filing",
      trace: {
        schemaVersion: "goat.brain_ingest_trace.v1",
        toolCallCount: 1,
      },
    });
    expect(legacy).toMatchObject({ trace: null });
  });

  it("reports failures and retries with the last error", () => {
    const failed = buildGoatBrainActivityEvents(
      [job({ status: "failed", attempts: 5, last_error: "Gateway timed out." })],
      [item()],
    );
    expect(failed.find((event) => event.kind === "failed")).toMatchObject({
      title: "Filing failed after 5 attempts",
      detail: "Gateway timed out.",
    });

    const retrying = buildGoatBrainActivityEvents(
      [job({ status: "queued", attempts: 2, last_error: "Brain changed while running." })],
      [item()],
    );
    expect(retrying.find((event) => event.kind === "retrying")).toMatchObject({
      title: "Filing failed — will retry",
      detail: "Brain changed while running.",
    });
  });

  it("sorts newest first and tolerates a missing source item", () => {
    const events = buildGoatBrainActivityEvents(
      [
        job({
          id: "gbjob_old",
          source_item_id: "gbsrc_missing",
          created_at: "2026-07-09T09:00:00.000Z",
        }),
        job({ id: "gbjob_new", created_at: "2026-07-09T11:00:00.000Z" }),
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

describe("buildGoatBrainDraftIngestStates", () => {
  it("maps pending chat capture jobs to their inbox draft id", () => {
    const states = buildGoatBrainDraftIngestStates([job()], [item()]);

    expect(states.get("pricing-reference")).toMatchObject({
      kind: "queued",
      jobId: "gbjob_1",
      title: "Pricing teardown reference",
      attempts: 0,
    });
  });

  it("uses running, retrying, and failed job states", () => {
    const running = buildGoatBrainDraftIngestStates(
      [job({ status: "running", attempts: 1 })],
      [item()],
    );
    expect(running.get("pricing-reference")).toMatchObject({ kind: "running", attempts: 1 });

    const retrying = buildGoatBrainDraftIngestStates(
      [job({ status: "queued", attempts: 2, last_error: "Brain changed while running." })],
      [item()],
    );
    expect(retrying.get("pricing-reference")).toMatchObject({
      kind: "retrying",
      detail: "Brain changed while running.",
    });

    const failed = buildGoatBrainDraftIngestStates(
      [job({ status: "failed", attempts: 5, last_error: "Gateway timed out." })],
      [item({ last_ingest_status: "failed" })],
    );
    expect(failed.get("pricing-reference")).toMatchObject({
      kind: "failed",
      detail: "Gateway timed out.",
    });
  });

  it("hides succeeded jobs and ignores non-capture source items", () => {
    expect(buildGoatBrainDraftIngestStates([job({ status: "succeeded" })], [item()]).size).toBe(0);
    expect(
      buildGoatBrainDraftIngestStates(
        [job({ source_provider: "jamie" })],
        [item({ source_provider: "jamie", source_type: "meeting" })],
      ).size,
    ).toBe(0);
  });
});
