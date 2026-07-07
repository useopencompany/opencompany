import { normalizeJamieMeetingCompletedWebhook } from "@opencompany/goat-brain";
import { describe, expect, it } from "vitest";
import { buildJamieMeetingBrainWrites } from "./goat-brain-ingest-worker";

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
    expect(first.meetingContent).toContain("type: meeting");
    expect(first.meetingContent).toContain("[[evidence:");
    expect(first.evidenceContent).toContain("evidenceKind: document");
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
});
