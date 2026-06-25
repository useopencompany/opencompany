import type { AgentEngine } from "@opencompany/agent-runtime/types";
import { createLogger } from "@opencompany/observability";
import {
  dispatchAgentApprovalResume,
  dispatchAgentMessageSubmitted,
  dispatchAgentQuestionResume,
} from "@/lib/agent-sessions/events";
import { callRunner } from "@/lib/agent-sessions/runner";

type TriggerAgentMessageRunInput = {
  sessionId: string;
  messageId: string;
  workspaceId: string;
  engine?: AgentEngine;
};

type TriggerAgentApprovalResumeInput = {
  sessionId: string;
  toolCallId: string;
  workspaceId?: string;
};

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export async function triggerAgentMessageRun(input: TriggerAgentMessageRunInput) {
  const engine = input.engine ?? "opencompany";
  const runnerPath =
    engine === "codex"
      ? `/internal/sessions/${input.sessionId}/messages/${input.messageId}/codex-turn`
      : `/internal/sessions/${input.sessionId}/messages/${input.messageId}/run`;
  const failureEvent =
    engine === "codex"
      ? "opencompany.direct_run_codex_turn_failed"
      : "opencompany.direct_run_message_failed";

  if (!canCallRunnerDirectly()) {
    logger.info("Falling back to Inngest runner dispatch", {
      event: "opencompany.runner_request_fallback",
      reason: "runner_direct_call_unconfigured",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      message_id: input.messageId,
    });
    await dispatchAgentMessageSubmitted({ ...input, engine });
    return;
  }

  try {
    await callRunner(runnerPath, {
      event: failureEvent,
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      message_id: input.messageId,
      engine,
    });
  } catch (error) {
    logger.warn("Falling back to Inngest runner dispatch", {
      event: "opencompany.runner_request_fallback",
      reason: "direct_runner_request_failed",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      message_id: input.messageId,
      error,
    });
    await dispatchAgentMessageSubmitted({ ...input, engine });
    return;
  }

  try {
    await callRunner(`/internal/sessions/${input.sessionId}/messages/${input.messageId}/title`, {
      event: "opencompany.direct_generate_title_failed",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      message_id: input.messageId,
    });
  } catch {
    // callRunner already captures the failure. Do not dispatch the shared message
    // event here, since that would schedule a duplicate message run.
  }
}

export async function triggerAgentApprovalResume(input: TriggerAgentApprovalResumeInput) {
  if (!canCallRunnerDirectly()) {
    logger.info("Falling back to Inngest runner dispatch", {
      event: "opencompany.runner_request_fallback",
      reason: "runner_direct_call_unconfigured",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      tool_call_id: input.toolCallId,
    });
    await dispatchAgentApprovalResume({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
    });
    return;
  }

  try {
    await callRunner(`/internal/sessions/${input.sessionId}/approvals/${input.toolCallId}/resume`, {
      event: "opencompany.direct_resume_approval_failed",
      session_id: input.sessionId,
      ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    });
  } catch (error) {
    logger.warn("Falling back to Inngest runner dispatch", {
      event: "opencompany.runner_request_fallback",
      reason: "direct_runner_request_failed",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      tool_call_id: input.toolCallId,
      error,
    });
    await dispatchAgentApprovalResume({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
    });
    return;
  }
}

export async function triggerAgentQuestionResume(input: TriggerAgentApprovalResumeInput) {
  if (!canCallRunnerDirectly()) {
    logger.info("Falling back to Inngest runner dispatch", {
      event: "opencompany.runner_request_fallback",
      reason: "runner_direct_call_unconfigured",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      tool_call_id: input.toolCallId,
    });
    await dispatchAgentQuestionResume({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
    });
    return;
  }

  try {
    await callRunner(`/internal/sessions/${input.sessionId}/questions/${input.toolCallId}/resume`, {
      event: "opencompany.direct_resume_question_failed",
      session_id: input.sessionId,
      ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    });
  } catch (error) {
    logger.warn("Falling back to Inngest runner dispatch", {
      event: "opencompany.runner_request_fallback",
      reason: "direct_runner_request_failed",
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      tool_call_id: input.toolCallId,
      error,
    });
    await dispatchAgentQuestionResume({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
    });
    return;
  }
}

function canCallRunnerDirectly() {
  return Boolean(
    (process.env.RUNNER_INTERNAL_URL || process.env.RUNNER_PUBLIC_URL) &&
      process.env.RUNNER_INTERNAL_TOKEN,
  );
}
