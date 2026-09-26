import { beforeEach, expect, it, vi } from "vitest";
import { resumeAfterPluginConnection } from "./plugin-connection-continuation";

const calls = vi.hoisted(() => ({
  chat: vi.fn(async () => undefined),
  task: vi.fn(async () => undefined),
}));
vi.mock("./headless-chat-transport", () => ({
  enqueueHeadlessChatMessage: calls.chat,
}));
vi.mock("./headless-task-commands", () => ({
  createHeadlessTaskComment: calls.task,
}));

beforeEach(() => {
  calls.chat.mockClear();
  calls.task.mockClear();
});

it("resumes a task with an idempotent comment ID", async () => {
  await resumeAfterPluginConnection({
    pluginName: "stripe",
    attemptId: "attempt_1",
    target: { kind: "task", taskId: "task_1", workspaceId: "workspace_1" },
  });
  expect(calls.task).toHaveBeenCalledWith(
    "task_1",
    {
      id: "task_activity_attempt_1",
      body: "The stripe connection is restored. Continue the previous request from where you stopped.",
    },
    { scopeKey: "workspace_1" },
  );
  expect(calls.chat).not.toHaveBeenCalled();
});

it("resumes a chat with an idempotent message ID and its existing engine", async () => {
  const engine = { type: "opencompany" as const, schemaVersion: 1 as const };
  await resumeAfterPluginConnection({
    pluginName: "google-drive",
    attemptId: "attempt_2",
    target: { kind: "chat", conversationId: "chat_1", model: "model_1", engine },
  });
  expect(calls.chat).toHaveBeenCalledWith({
    content:
      "The google drive connection is restored. Continue the previous request from where you stopped.",
    conversationId: "chat_1",
    clientMessageId: "ui_queued_attempt_2",
    model: "model_1",
    engine,
  });
});
