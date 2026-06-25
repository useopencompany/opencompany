import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAgentMessageSubmitted } from "@/lib/agent-sessions/events";
import { callRunner } from "@/lib/agent-sessions/runner";
import { triggerAgentMessageRun } from "./message-runner";

vi.mock("@/lib/agent-sessions/events", () => ({
  dispatchAgentMessageSubmitted: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/runner", () => ({
  callRunner: vi.fn(),
}));

const callRunnerMock = vi.mocked(callRunner);
const dispatchAgentMessageSubmittedMock = vi.mocked(dispatchAgentMessageSubmitted);

const input = {
  sessionId: "ses_123",
  messageId: "msg_123",
  workspaceId: "wks_123",
};

describe("triggerAgentMessageRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dispatches the shared event when the runner cannot be called directly", async () => {
    await triggerAgentMessageRun(input);

    expect(dispatchAgentMessageSubmittedMock).toHaveBeenCalledWith({
      ...input,
      engine: "opencompany",
    });
    expect(callRunnerMock).not.toHaveBeenCalled();
  });

  it("calls both direct runner endpoints when direct runner config is available", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "http://runner.local");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "secret");

    await triggerAgentMessageRun(input);

    expect(callRunnerMock).toHaveBeenCalledTimes(2);
    expect(callRunnerMock).toHaveBeenNthCalledWith(
      1,
      "/internal/sessions/ses_123/messages/msg_123/run",
      {
        event: "opencompany.direct_run_message_failed",
        workspace_id: "wks_123",
        session_id: "ses_123",
        message_id: "msg_123",
        engine: "opencompany",
      },
    );
    expect(callRunnerMock).toHaveBeenNthCalledWith(
      2,
      "/internal/sessions/ses_123/messages/msg_123/title",
      {
        event: "opencompany.direct_generate_title_failed",
        workspace_id: "wks_123",
        session_id: "ses_123",
        message_id: "msg_123",
      },
    );
    expect(dispatchAgentMessageSubmittedMock).not.toHaveBeenCalled();
  });

  it("calls the Codex turn endpoint when the session engine is codex", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "http://runner.local");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "secret");

    await triggerAgentMessageRun({ ...input, engine: "codex" });

    expect(callRunnerMock).toHaveBeenNthCalledWith(
      1,
      "/internal/sessions/ses_123/messages/msg_123/codex-turn",
      {
        event: "opencompany.direct_run_codex_turn_failed",
        workspace_id: "wks_123",
        session_id: "ses_123",
        message_id: "msg_123",
        engine: "codex",
      },
    );
  });

  it("falls back to the shared event when the direct run request fails", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "http://runner.local");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "secret");
    callRunnerMock.mockRejectedValueOnce(new Error("run failed"));

    await triggerAgentMessageRun(input);

    expect(callRunnerMock).toHaveBeenCalledTimes(1);
    expect(dispatchAgentMessageSubmittedMock).toHaveBeenCalledWith({
      ...input,
      engine: "opencompany",
    });
  });

  it("does not dispatch the shared event when only direct title generation fails", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "http://runner.local");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "secret");
    callRunnerMock.mockResolvedValueOnce(undefined);
    callRunnerMock.mockRejectedValueOnce(new Error("title failed"));

    await triggerAgentMessageRun(input);

    expect(callRunnerMock).toHaveBeenCalledTimes(2);
    expect(dispatchAgentMessageSubmittedMock).not.toHaveBeenCalled();
  });
});
