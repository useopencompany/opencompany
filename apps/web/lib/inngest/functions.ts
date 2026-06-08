import {
  AFTER_SESSION_IDLE_TRIGGER_SECONDS,
  TOOL_APPROVAL_BACKSTOP_MS,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { indexPendingMessageChunks, RECALL_INDEX_SWEEP_LIMIT } from "@opencompany/db/recall";
import { agentSessionQuestions, agentToolApprovals } from "@opencompany/db/schema";
import { and, eq, lt } from "drizzle-orm";
import {
  AGENT_SCHEDULE_SWEEP_CRON,
  sweepAgentSchedules as runAgentScheduleSweep,
} from "@/lib/agent-schedules/runner";
import {
  AGENT_AFTER_SESSION_CHECK_EVENT,
  AGENT_APPROVAL_RESUME_EVENT,
  AGENT_MESSAGE_SUBMITTED_EVENT,
  AGENT_QUESTION_RESUME_EVENT,
  AGENT_SESSION_ABORT_REQUESTED_EVENT,
  AGENT_SESSION_STARTED_EVENT,
} from "@/lib/agent-sessions/events";
import {
  triggerAgentApprovalResume,
  triggerAgentQuestionResume,
} from "@/lib/agent-sessions/message-runner";
import { callRunner } from "@/lib/agent-sessions/runner";
import { BRAIN_SYNC_DELAY_MS } from "@/lib/brain/jobs";
import { SIGNUP_WELCOME_EMAIL_REQUESTED_EVENT } from "@/lib/email/events";
import { type SignupWelcomeEmailInput, sendSignupWelcomeEmail } from "@/lib/email/signup-welcome";
import { inngest } from "@/lib/inngest/client";
import { runProvisionSlackSupport } from "@/lib/inngest/provision-slack-support";
import { runDeliverWhatsappReply, runWhatsappDeliverySweep } from "@/lib/messaging/delivery";
import {
  type DeliverWhatsappReplyInput,
  WHATSAPP_DELIVER_REPLY_EVENT,
  WHATSAPP_DELIVERY_SWEEP_CRON,
} from "@/lib/messaging/events";
import { SLACK_SUPPORT_CHANNEL_REQUESTED_EVENT } from "@/lib/slack/events";
import {
  sweepWorkspaceSyncOutbox as runWorkspaceSyncOutboxSweep,
  SYNC_OUTBOX_SWEEP_CRON,
} from "@/lib/sync-outbox/sweeper";
import { projectWorkspaceToGitHub } from "@/lib/workspace-state/project";
import { WORKSPACE_SYNC_REQUESTED_EVENT } from "@/lib/workspace-state/sync-events";

// Unified workspace projection. One event per workspace (deduped by the
// concurrency key) drains all due workspace_sync_jobs into a single GitHub
// commit. The loop re-projects while a batch committed, absorbing edits that
// landed during the GitHub round-trip; the cap bounds a busy workspace.
export const syncWorkspaceToGitHub = inngest.createFunction(
  {
    id: "sync-workspace-to-github",
    name: "Sync workspace to GitHub",
    retries: 5,
    concurrency: {
      limit: 1,
      key: "event.data.workspaceId",
    },
    triggers: { event: WORKSPACE_SYNC_REQUESTED_EVENT },
  },
  async ({ event, step }) => {
    await step.sleep("coalesce workspace edits", `${BRAIN_SYNC_DELAY_MS / 1000}s`);

    return step.run("project workspace to github", async () => {
      const MAX_ITERATIONS = 5;
      let last: Awaited<ReturnType<typeof projectWorkspaceToGitHub>> = { status: "idle" };
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        last = await projectWorkspaceToGitHub({ workspaceId: event.data.workspaceId });
        if (last.status !== "synced") break;
      }
      return last;
    });
  },
);

export const sweepWorkspaceSyncOutbox = inngest.createFunction(
  {
    id: "sweep-workspace-sync-outbox",
    name: "Sweep workspace sync outbox",
    retries: 3,
    concurrency: { limit: 1 },
    triggers: { cron: SYNC_OUTBOX_SWEEP_CRON },
  },
  async ({ step }) => {
    return runWorkspaceSyncOutboxSweep(step);
  },
);

// Cross-session recall index. Chunks completed user/assistant messages into the searchable
// agent_session_message_chunks projection (see @opencompany/db/recall) so the runner-side `recall`
// tool can find them. The sweep is idempotent and re-entrant: it drains a fresh session's messages
// within a minute and backfills history over successive runs. Each run loops a few batches so a
// backlog catches up quickly without one cron tick doing unbounded work.
const RECALL_INDEX_SWEEP_CRON = "* * * * *";
const RECALL_INDEX_SWEEP_MAX_ITERATIONS = 5;

export const sweepRecallIndex = inngest.createFunction(
  {
    id: "sweep-recall-index",
    name: "Sweep cross-session recall index",
    retries: 3,
    concurrency: { limit: 1 },
    triggers: { cron: RECALL_INDEX_SWEEP_CRON },
  },
  async ({ step }) => {
    const db = getDb();
    let indexed = 0;
    for (let iteration = 0; iteration < RECALL_INDEX_SWEEP_MAX_ITERATIONS; iteration += 1) {
      const result = (await step.run(`index message chunks ${iteration}`, async () =>
        indexPendingMessageChunks(db),
      )) as Awaited<ReturnType<typeof indexPendingMessageChunks>>;
      indexed += result.indexed;
      // A non-full batch means the backlog is drained; stop until the next tick.
      if (result.scanned < RECALL_INDEX_SWEEP_LIMIT) break;
    }
    return { indexed };
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
    const idleDelaySeconds =
      typeof event.data.idleDelaySeconds === "number" && event.data.idleDelaySeconds > 0
        ? event.data.idleDelaySeconds
        : AFTER_SESSION_IDLE_TRIGGER_SECONDS;
    await step.sleep("wait for session idle", `${idleDelaySeconds}s`);

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
          and(eq(agentToolApprovals.status, "pending"), lt(agentToolApprovals.requestedAt, cutoff)),
        )
        .limit(100);
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
            and(eq(agentToolApprovals.id, approval.id), eq(agentToolApprovals.status, "pending")),
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

export const runAgentQuestionResume = inngest.createFunction(
  {
    id: "run-agent-question-resume",
    name: "Run agent question resume",
    retries: 3,
    concurrency: {
      limit: 1,
      key: "event.data.sessionId",
    },
    triggers: { event: AGENT_QUESTION_RESUME_EVENT },
  },
  async ({ event, step }) => {
    return step.run("resume runner question", async () => {
      await callRunner(
        `/internal/sessions/${event.data.sessionId}/questions/${event.data.toolCallId}/resume`,
        {
          event: "opencompany.inngest_resume_question_failed",
          session_id: event.data.sessionId,
        },
      );
      return { ok: true };
    });
  },
);

// Backstop sweep for ask_user_question: pending questions older than the backstop window are
// auto-cancelled with resolutionSource='timeout' so a run never hangs forever waiting on the user.
// The atomic, status-guarded UPDATE means a concurrent user answer always wins; only rows this
// sweep actually flips trigger a resume.
export const sweepExpiredSessionQuestions = inngest.createFunction(
  {
    id: "sweep-expired-session-questions",
    name: "Sweep expired session questions",
    retries: 3,
    concurrency: { limit: 1 },
    triggers: { cron: TOOL_APPROVAL_SWEEP_CRON },
  },
  async ({ step }) => {
    const db = getDb();
    const cutoff = new Date(Date.now() - TOOL_APPROVAL_BACKSTOP_MS);

    const expired = await step.run("select expired pending questions", async () => {
      return db
        .select({
          id: agentSessionQuestions.id,
          sessionId: agentSessionQuestions.sessionId,
          toolCallId: agentSessionQuestions.toolCallId,
        })
        .from(agentSessionQuestions)
        .where(
          and(
            eq(agentSessionQuestions.status, "pending"),
            lt(agentSessionQuestions.requestedAt, cutoff),
          ),
        )
        .limit(100);
    });

    let cancelled = 0;
    for (const question of expired) {
      const flippedRow = await step.run(`cancel question ${question.id}`, async () => {
        const updated = await db
          .update(agentSessionQuestions)
          .set({
            status: "cancelled",
            resolutionSource: "timeout",
            answeredAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentSessionQuestions.id, question.id),
              eq(agentSessionQuestions.status, "pending"),
            ),
          )
          .returning({ id: agentSessionQuestions.id });
        return updated.length > 0;
      });

      if (!flippedRow) continue;
      cancelled += 1;

      await step.run(`resume question ${question.id}`, async () => {
        await triggerAgentQuestionResume({
          sessionId: question.sessionId,
          toolCallId: question.toolCallId,
        });
        return { ok: true };
      });
    }

    return { scanned: expired.length, cancelled };
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

export const provisionSlackSupportChannel = inngest.createFunction(
  {
    id: "provision-slack-support-channel",
    name: "Provision Slack support channel",
    retries: 3,
    // No `idempotency` key: it would dedupe re-dispatches within Inngest's window and
    // permanently block recovery of a `failed` workspace. Single-channel safety comes
    // from the per-workspace concurrency lock + the DB unique index + the active
    // short-circuit + per-step channel-id resume in runProvisionSlackSupport.
    concurrency: {
      limit: 1,
      key: "event.data.workspaceId",
    },
    triggers: { event: SLACK_SUPPORT_CHANNEL_REQUESTED_EVENT },
  },
  // Cast at the Inngest adapter boundary: the runtime event/step are structurally
  // compatible with the handler's narrow types (which keep it unit-testable).
  async ({ event, step }) =>
    runProvisionSlackSupport({ event, step } as unknown as Parameters<
      typeof runProvisionSlackSupport
    >[0]),
);

// Outbound WhatsApp delivery, web-side only (the runner never learns about channels). Polls for the
// completed assistant reply, then sends it over the Cloud API. Per-session concurrency preserves
// reply ordering within a thread.
export const deliverWhatsappReply = inngest.createFunction(
  {
    id: "deliver-whatsapp-reply",
    name: "Deliver WhatsApp reply",
    retries: 3,
    concurrency: {
      limit: 1,
      key: "event.data.sessionId",
    },
    triggers: { event: WHATSAPP_DELIVER_REPLY_EVENT },
  },
  // Cast at the Inngest adapter boundary: the runtime step is structurally compatible with the
  // narrow WorkflowStep the handler accepts (which keeps it unit-testable).
  async ({ event, step }) =>
    runDeliverWhatsappReply({
      data: event.data as DeliverWhatsappReplyInput,
      step: step as unknown as Parameters<typeof runDeliverWhatsappReply>[0]["step"],
    }),
);

// Backstop: re-deliver any recently-completed WhatsApp reply with no outbound row (a per-message job
// that timed out or didn't run). The outbound-existence guard in deliverReply keeps this safe.
export const sweepWhatsappDeliveries = inngest.createFunction(
  {
    id: "sweep-whatsapp-deliveries",
    name: "Sweep WhatsApp deliveries",
    retries: 3,
    concurrency: { limit: 1 },
    triggers: { cron: WHATSAPP_DELIVERY_SWEEP_CRON },
  },
  async ({ step }) =>
    runWhatsappDeliverySweep(step as unknown as Parameters<typeof runWhatsappDeliverySweep>[0]),
);

export const inngestFunctions = [
  syncWorkspaceToGitHub,
  sweepWorkspaceSyncOutbox,
  sweepRecallIndex,
  startAgentSession,
  runAgentSessionMessage,
  generateAgentSessionTitle,
  runAgentAfterSession,
  sweepAgentSchedules,
  abortAgentSession,
  runAgentApprovalResume,
  sweepExpiredToolApprovals,
  runAgentQuestionResume,
  sweepExpiredSessionQuestions,
  sendSignupWelcome,
  provisionSlackSupportChannel,
  deliverWhatsappReply,
  sweepWhatsappDeliveries,
];
