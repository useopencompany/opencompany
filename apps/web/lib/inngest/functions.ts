import { TOOL_APPROVAL_BACKSTOP_MS } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agentToolApprovals } from "@opencompany/db/schema";
import { and, eq, lt } from "drizzle-orm";
import {
  AGENT_SCHEDULE_SWEEP_CRON,
  sweepAgentSchedules as runAgentScheduleSweep,
} from "@/lib/agent-schedules/runner";
import {
  AGENT_AFTER_SESSION_CHECK_EVENT,
  AGENT_APPROVAL_RESUME_EVENT,
  AGENT_MESSAGE_SUBMITTED_EVENT,
  AGENT_SESSION_ABORT_REQUESTED_EVENT,
  AGENT_SESSION_STARTED_EVENT,
} from "@/lib/agent-sessions/events";
import { triggerAgentApprovalResume } from "@/lib/agent-sessions/message-runner";
import { callRunner } from "@/lib/agent-sessions/runner";
import { materializeAgentToGitHub } from "@/lib/agents/materialize";
import { AGENT_SYNC_REQUESTED_EVENT } from "@/lib/agents/sync-events";
import { BRAIN_SYNC_DELAY_MS } from "@/lib/brain/jobs";
import { materializeBrainFileToGitHub } from "@/lib/brain/materialize";
import { BRAIN_SYNC_REQUESTED_EVENT } from "@/lib/brain/sync-events";
import { SIGNUP_WELCOME_EMAIL_REQUESTED_EVENT } from "@/lib/email/events";
import { type SignupWelcomeEmailInput, sendSignupWelcomeEmail } from "@/lib/email/signup-welcome";
import { inngest } from "@/lib/inngest/client";
import {
  sweepAgentSyncOutbox as runAgentSyncOutboxSweep,
  sweepBrainSyncOutbox as runBrainSyncOutboxSweep,
  SYNC_OUTBOX_SWEEP_CRON,
} from "@/lib/sync-outbox/sweeper";

export const syncAgentToGitHub = inngest.createFunction(
  {
    id: "sync-agent-to-github",
    name: "Sync agent to GitHub",
    retries: 5,
    concurrency: {
      limit: 1,
      key: "event.data.agentId",
    },
    triggers: { event: AGENT_SYNC_REQUESTED_EVENT },
  },
  async ({ event, step }) => {
    await step.sleep("coalesce agent edits", "10s");

    return step.run("materialize latest agent file", async () => {
      return materializeAgentToGitHub(event.data.agentId, { mode: "scheduled" });
    });
  },
);

export const syncBrainToGitHub = inngest.createFunction(
  {
    id: "sync-brain-to-github",
    name: "Sync brain to GitHub",
    retries: 5,
    concurrency: {
      limit: 1,
      key: "event.data.workspaceId + ':' + event.data.path",
    },
    triggers: { event: BRAIN_SYNC_REQUESTED_EVENT },
  },
  async ({ event, step }) => {
    await step.sleep("coalesce brain edits", `${BRAIN_SYNC_DELAY_MS / 1000}s`);

    return step.run("materialize latest brain file", async () => {
      return materializeBrainFileToGitHub({
        workspaceId: event.data.workspaceId,
        path: event.data.path,
      });
    });
  },
);

export const sweepAgentSyncOutbox = inngest.createFunction(
  {
    id: "sweep-agent-sync-outbox",
    name: "Sweep agent sync outbox",
    retries: 3,
    concurrency: { limit: 1 },
    triggers: { cron: SYNC_OUTBOX_SWEEP_CRON },
  },
  async ({ step }) => {
    return runAgentSyncOutboxSweep(step);
  },
);

export const sweepBrainSyncOutbox = inngest.createFunction(
  {
    id: "sweep-brain-sync-outbox",
    name: "Sweep brain sync outbox",
    retries: 3,
    concurrency: { limit: 1 },
    triggers: { cron: SYNC_OUTBOX_SWEEP_CRON },
  },
  async ({ step }) => {
    return runBrainSyncOutboxSweep(step);
  },
);

export const startAgentSession = inngest.createFunction(
  {
    id: "start-agent-session",
    name: "Start agent session",
    retries: 3,
    concurrency: {
      limit: 1,
      key: "event.data.sessionId",
    },
    triggers: { event: AGENT_SESSION_STARTED_EVENT },
  },
  async ({ event, step }) => {
    return step.run("start runner session", async () => {
      await callRunner(`/internal/sessions/${event.data.sessionId}/start`, {
        event: "opencompany.inngest_start_runner_failed",
        workspace_id: event.data.workspaceId,
        session_id: event.data.sessionId,
      });
      return { ok: true };
    });
  },
);

export const runAgentSessionMessage = inngest.createFunction(
  {
    id: "run-agent-session-message",
    name: "Run agent session message",
    retries: 3,
    concurrency: {
      limit: 1,
      key: "event.data.sessionId",
    },
    triggers: { event: AGENT_MESSAGE_SUBMITTED_EVENT },
  },
  async ({ event, step }) => {
    return step.run("run runner message", async () => {
      await callRunner(
        `/internal/sessions/${event.data.sessionId}/messages/${event.data.messageId}/run`,
        {
          event: "opencompany.inngest_run_message_failed",
          workspace_id: event.data.workspaceId,
          session_id: event.data.sessionId,
          message_id: event.data.messageId,
        },
      );
      return { ok: true };
    });
  },
);

export const generateAgentSessionTitle = inngest.createFunction(
  {
    id: "generate-agent-session-title",
    name: "Generate agent session title",
    retries: 1,
    concurrency: {
      limit: 1,
      key: "event.data.sessionId",
    },
    triggers: { event: AGENT_MESSAGE_SUBMITTED_EVENT },
  },
  async ({ event, step }) => {
    return step.run("generate runner session title", async () => {
      await callRunner(
        `/internal/sessions/${event.data.sessionId}/messages/${event.data.messageId}/title`,
        {
          event: "opencompany.inngest_generate_title_failed",
          workspace_id: event.data.workspaceId,
          session_id: event.data.sessionId,
          message_id: event.data.messageId,
        },
      );
      return { ok: true };
    });
  },
);

export const runAgentAfterSession = inngest.createFunction(
  {
    id: "run-agent-after-session",
    name: "Run agent after-session hook",
    retries: 3,
    concurrency: {
      limit: 1,
      key: "event.data.sessionId",
    },
    triggers: { event: AGENT_AFTER_SESSION_CHECK_EVENT },
  },
  async ({ event, step }) => {
    await step.sleep("wait for session idle", "180s");

    return step.run("run after-session hook if still idle", async () => {
      await callRunner(
        `/internal/sessions/${event.data.sessionId}/after-session?messageId=${encodeURIComponent(
          event.data.messageId,
        )}`,
        {
          event: "opencompany.inngest_after_session_failed",
          workspace_id: event.data.workspaceId,
          session_id: event.data.sessionId,
          message_id: event.data.messageId,
        },
      );
      return { ok: true };
    });
  },
);

export const sweepAgentSchedules = inngest.createFunction(
  {
    id: "sweep-agent-schedules",
    name: "Sweep agent schedules",
    retries: 3,
    concurrency: { limit: 1 },
    triggers: { cron: AGENT_SCHEDULE_SWEEP_CRON },
  },
  async ({ step }) => {
    return step.run("run due agent schedules", async () => {
      return runAgentScheduleSweep();
    });
  },
);

export const abortAgentSession = inngest.createFunction(
  {
    id: "abort-agent-session",
    name: "Abort agent session",
    retries: 1,
    triggers: { event: AGENT_SESSION_ABORT_REQUESTED_EVENT },
  },
  async ({ event, step }) => {
    return step.run("abort runner session", async () => {
      await callRunner(`/internal/sessions/${event.data.sessionId}/abort`, {
        event: "opencompany.inngest_abort_runner_failed",
        workspace_id: event.data.workspaceId,
        session_id: event.data.sessionId,
      });
      return { ok: true };
    });
  },
);

export const runAgentApprovalResume = inngest.createFunction(
  {
    id: "run-agent-approval-resume",
    name: "Run agent approval resume",
    retries: 3,
    concurrency: {
      limit: 1,
      key: "event.data.sessionId",
    },
    triggers: { event: AGENT_APPROVAL_RESUME_EVENT },
  },
  async ({ event, step }) => {
    return step.run("resume runner approval", async () => {
      await callRunner(
        `/internal/sessions/${event.data.sessionId}/approvals/${event.data.toolCallId}/resume`,
        {
          event: "opencompany.inngest_resume_approval_failed",
          session_id: event.data.sessionId,
        },
      );
      return { ok: true };
    });
  },
);

// Backstop sweep: pending approvals older than the backstop window are auto-denied with
// decisionSource='timeout' so a run never hangs forever waiting on a user. The atomic,
// status-guarded UPDATE means a concurrent user decision always wins; only rows this
// sweep actually flips trigger a resume.
const TOOL_APPROVAL_SWEEP_CRON = "0 * * * *";

export const sweepExpiredToolApprovals = inngest.createFunction(
  {
    id: "sweep-expired-tool-approvals",
    name: "Sweep expired tool approvals",
    retries: 3,
    concurrency: { limit: 1 },
    triggers: { cron: TOOL_APPROVAL_SWEEP_CRON },
  },
  async ({ step }) => {
    const db = getDb();
    const cutoff = new Date(Date.now() - TOOL_APPROVAL_BACKSTOP_MS);

    const expired = await step.run("select expired pending approvals", async () => {
      return db
        .select({
          id: agentToolApprovals.id,
          sessionId: agentToolApprovals.sessionId,
          toolCallId: agentToolApprovals.toolCallId,
        })
        .from(agentToolApprovals)
        .where(
          and(
            eq(agentToolApprovals.status, "pending"),
            lt(agentToolApprovals.requestedAt, cutoff),
          ),
        );
    });

    let denied = 0;
    for (const approval of expired) {
      const flippedRow = await step.run(`deny approval ${approval.id}`, async () => {
        const updated = await db
          .update(agentToolApprovals)
          .set({
            status: "denied",
            decisionSource: "timeout",
            decidedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentToolApprovals.id, approval.id),
              eq(agentToolApprovals.status, "pending"),
            ),
          )
          .returning({ id: agentToolApprovals.id });
        return updated.length > 0;
      });

      if (!flippedRow) continue;
      denied += 1;

      await step.run(`resume approval ${approval.id}`, async () => {
        await triggerAgentApprovalResume({
          sessionId: approval.sessionId,
          toolCallId: approval.toolCallId,
        });
        return { ok: true };
      });
    }

    return { scanned: expired.length, denied };
  },
);

export const sendSignupWelcome = inngest.createFunction(
  {
    id: "send-signup-welcome-email",
    name: "Send signup welcome email",
    retries: 3,
    concurrency: {
      limit: 1,
      key: "event.data.userId",
    },
    triggers: { event: SIGNUP_WELCOME_EMAIL_REQUESTED_EVENT },
  },
  async ({ event, step }) => {
    return step.run("send signup welcome email", async () => {
      return sendSignupWelcomeEmail(event.data as SignupWelcomeEmailInput);
    });
  },
);

export const inngestFunctions = [
  syncAgentToGitHub,
  syncBrainToGitHub,
  sweepAgentSyncOutbox,
  sweepBrainSyncOutbox,
  startAgentSession,
  runAgentSessionMessage,
  generateAgentSessionTitle,
  runAgentAfterSession,
  sweepAgentSchedules,
  abortAgentSession,
  runAgentApprovalResume,
  sweepExpiredToolApprovals,
  sendSignupWelcome,
];
