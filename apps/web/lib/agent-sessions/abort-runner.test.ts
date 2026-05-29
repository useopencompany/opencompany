import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAgentSessionAbortRequested } from "@/lib/agent-sessions/events";
import { callRunner } from "@/lib/agent-sessions/runner";
import { triggerAgentSessionAbort } from "./abort-runner";

vi.mock("@/lib/agent-sessions/events", () => ({
  dispatchAgentSessionAbortRequested: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/runner", () => ({
  callRunner: vi.fn(),
}));

const callRunnerMock = vi.mocked(callRunner);
const dispatchAgentSessionAbortRequestedMock = vi.mocked(dispatchAgentSessionAbortRequested);

const input = {
  sessionId: "ses_123",
  workspaceId: "wks_123",
};

describe("triggerAgentSessionAbort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dispatches via Inngest when the runner cannot be called directly", async () => {
    await triggerAgentSessionAbort(input);

    expect(dispatchAgentSessionAbortRequestedMock).toHaveBeenCalledWith(input);
    expect(callRunnerMock).not.toHaveBeenCalled();
  });

  it("calls the runner abort endpoint directly when runner config is available", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "http://runner.local");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "secret");

    await triggerAgentSessionAbort(input);

    expect(callRunnerMock).toHaveBeenCalledOnce();
    expect(callRunnerMock).toHaveBeenCalledWith("/internal/sessions/ses_123/abort", {
      event: "opencompany.direct_abort_session_failed",
      workspace_id: "wks_123",
      session_id: "ses_123",
    });
    expect(dispatchAgentSessionAbortRequestedMock).not.toHaveBeenCalled();
  });

  it("falls back to Inngest dispatch when the direct runner abort request fails", async () => {
    vi.stubEnv("RUNNER_INTERNAL_URL", "http://runner.local");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "secret");
    callRunnerMock.mockRejectedValueOnce(new Error("abort failed"));

    await triggerAgentSessionAbort(input);

    expect(callRunnerMock).toHaveBeenCalledOnce();
    expect(dispatchAgentSessionAbortRequestedMock).toHaveBeenCalledWith(input);
  });
});
