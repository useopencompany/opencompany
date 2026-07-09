import { describe, expect, it } from "vitest";
import { buildGoatBrainActivityEvents } from "@/lib/brain-activity";
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
    expect(events[0]).toMatchObject({ title: "Filing into brain…" });
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
    });
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
