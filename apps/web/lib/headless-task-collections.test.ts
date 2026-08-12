import type { LegacyTaskDto, TaskReadModel } from "@opencompany/protocol";
import { describe, expect, it } from "vitest";
import { legacyTaskDtoToRow, taskReadModelToRow } from "./headless-task-collections";

const canonicalTask: TaskReadModel = {
  id: "task_1",
  displayId: "TASK-1",
  name: "Prepare launch brief",
  goal: "Prepare a launch brief",
  conversationId: "conversation_1",
  status: "blocked",
  source: "workflow",
  engine: "claude_code",
  model: "anthropic/claude-sonnet-5",
  workflowId: "workflow_1",
  scheduleId: null,
  scheduledFor: null,
  outcome: { result: null, error: null, reportedStatus: "needs_attention", comment: "Review" },
  archivedAt: null,
  createdAt: "2026-08-11T09:00:00.000Z",
  updatedAt: "2026-08-11T09:01:00.000Z",
};

describe("headless Task presentation adapters", () => {
  it("projects canonical metadata without exposing execution persistence", () => {
    expect(taskReadModelToRow(canonicalTask)).toMatchObject({
      id: "task_1",
      display_id: "TASK-1",
      prompt: "Prepare a launch brief",
      session_id: "conversation_1",
      status: "running",
      stage: "running",
      workflow_id: "workflow_1",
      engine: "claude_code",
      reported_outcome: "needs_attention",
    });
  });

  it("marks compatibility history as sessionless and immutable presentation data", () => {
    const { conversationId, ...legacyTask } = canonicalTask;
    expect(conversationId).toBe("conversation_1");
    const row = legacyTaskDtoToRow({
      ...(legacyTask as LegacyTaskDto),
      status: "archived",
      archivedAt: "2026-08-11T10:00:00.000Z",
    });

    expect(row).toMatchObject({
      id: "task_1",
      session_id: null,
      status: "succeeded",
      stage: "completed",
      archived_at: "2026-08-11T10:00:00.000Z",
    });
  });
});
