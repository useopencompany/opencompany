import { normalizeJamieMeetingCompletedWebhook } from "@opencompany/goat-brain";
import { describe, expect, it, vi } from "vitest";
import {
  type GoatBrainIngestStore,
  runClaimedGoatBrainIngestJob,
} from "./goat-brain-ingest-worker";
import { buildJamieMeetingBrainWrites } from "./goat-brain-jamie-writes";

function jamieItem(segmentCount = 2) {
  return normalizeJamieMeetingCompletedWebhook(
    {
      metadata: {
        event: "meeting.completed",
        created: "2026-01-01T11:00:00.000Z",
      },
      data: {
        user: { id: "user_123" },
        event: {
          externalId: "calendar_event_123",
          title: "Roadmap Review",
          startTime: "2026-01-01T10:00:00.000Z",
          summary: "Discussed priorities for the next product cycle.",
          participants: [{ name: "Jamie", email: "jamie@example.com" }],
          actionItems: ["Share the revised roadmap"],
          transcript: Array.from({ length: segmentCount }, (_, index) => ({
            speakerName: index % 2 === 0 ? "Jamie" : "Alex",
            startTime: `00:${String(index).padStart(2, "0")}:00`,
            text: `Transcript segment ${index}`,
          })),
        },
      },
    },
    { capturedAt: "2026-01-01T11:01:00.000Z" },
  );
}

describe("Goat Brain ingest worker", () => {
  it("builds deterministic Jamie meeting and evidence documents", () => {
    const first = buildJamieMeetingBrainWrites(jamieItem());
    const second = buildJamieMeetingBrainWrites(jamieItem());

    expect(second.meetingBrainId).toBe(first.meetingBrainId);
    expect(second.evidenceBrainId).toBe(first.evidenceBrainId);
    expect(first.meetingContent).toContain("kind: page");
    expect(first.meetingContent).toContain("type: meeting");
    expect(first.meetingContent).toContain("folder: meetings");
    expect(first.meetingContent).toContain("[[evidence:");
    expect(first.evidenceContent).toContain("kind: evidence");
    expect(first.evidenceContent).toContain("type: meeting");
    expect(first.evidenceContent).toContain("folder: evidence/document");
    expect(first.evidenceContent).toContain("Transcript segment 0");
    expect(first.truncatedTranscript).toBe(false);
  });

  it("bounds large Jamie transcripts in Brain evidence", () => {
    const item = jamieItem(5000);
    item.content.meeting.transcript = item.content.meeting.transcript.map((segment) => ({
      ...segment,
      text: "large transcript segment ".repeat(200),
    }));

    const writes = buildJamieMeetingBrainWrites(item);

    expect(writes.truncatedTranscript).toBe(true);
    expect(writes.evidenceContent).toContain("Transcript truncated after");
    expect(Buffer.byteLength(writes.evidenceContent, "utf8")).toBeLessThan(1_000_000);
  });

  it("dispatches claimed jobs through a registered source handler", async () => {
    const normalizedPayload = {
      sourceProvider: "jamie" as const,
      sourceType: "meeting" as const,
      externalId: "external_123",
      sourceRef: "jamie:meeting:external_123",
      title: "Registry Test",
      occurredAt: "2026-01-01T10:00:00.000Z",
      capturedAt: "2026-01-01T10:01:00.000Z",
      contentHash: "hash_123",
      contentHashInput: {},
      content: {},
    };
    const run = vi.fn(async () => ({ handled: true }));
    const complete = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const store: GoatBrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      complete,
      fail,
    };

    await runClaimedGoatBrainIngestJob({
      env: { jobLeaseTtlMs: 30_000, vercelAiGatewayApiKey: "gw_test" },
      store,
      handlers: [
        {
          descriptor: {
            kind: "brain_source_item_ingest",
            sourceProvider: "jamie",
            sourceType: "meeting",
          },
          isPayload: (value): value is typeof normalizedPayload => value === normalizedPayload,
          run,
        },
      ],
      job: {
        id: "gbjob_123",
        sourceItemId: "gbsrc_123",
        userWorkosId: "user_123",
        sourceProvider: "jamie",
        sourceConnectionId: "gint_123",
        integrationId: "gint_123",
        brainRef: "gbrain_123",
        sourceType: "meeting",
        kind: "brain_source_item_ingest",
        contentHash: "hash_123",
        status: "running",
        attempts: 1,
        nextRunAt: new Date("2026-01-01T10:00:00.000Z"),
        leaseId: "lease_123",
        leaseOwner: "runner_123",
        leaseExpiresAt: new Date("2026-01-01T10:05:00.000Z"),
        lastError: null,
        result: {},
        completedAt: null,
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
        updatedAt: new Date("2026-01-01T10:00:00.000Z"),
        normalizedPayload,
      },
    });

    expect(run).toHaveBeenCalledWith({
      jobId: "gbjob_123",
      userWorkosId: "user_123",
      brainRef: "gbrain_123",
      item: normalizedPayload,
      env: { vercelAiGatewayApiKey: "gw_test" },
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ result: { handled: true } }));
    expect(fail).not.toHaveBeenCalled();
  });
});
