import {
  type AgentConfig,
  agentHasGitHubAccess,
  normalizeAgentConfig,
  serializeAgentFile,
} from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { DEFAULT_SANDBOX_RESOURCES, type SandboxResourceConfig } from "@opencompany/billing";
import {
  agentSessionAfterSessionRuns,
  agentSessionEvents,
  agentSessionMessages,
  agentSessionQuestions,
  agentSessions,
  agents,
  agentToolApprovals,
  users,
  workspaceRepositories,
  workspaces,
} from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import {
  type BraintrustSpan,
  logBraintrustSpan,
  traceBraintrustStep,
} from "@opencompany/observability/braintrust";
import { and, asc, desc, eq, gt, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { abortActiveRun } from "./active-runs";
import { materializeAgentBundleForSession } from "./agent-bundle";
import { materializeLargeTextAttachmentsForSession } from "./attachment-materialize";
import { materializeBrainForSession } from "./brain";
import { getDb } from "./db";
import { closeSessionStream } from "./durable-streams";
import { brokerActive, type RunnerEnv } from "./env";
import { appendRuntimeEvent } from "./events";
import { settleBrokerTokensForSession } from "./llm-broker-tokens";
import {
  armSandboxIdleTimeout,
  connectSandbox,
  createOrConnectSandbox,
  killSandbox,
  prepareWorkspace,
  type SandboxHandle,
  type SandboxLatencyObservation,
  sandboxPreparationErrorFields,
} from "./sandbox";
import { materializeSkillsForSession } from "./skills";

const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

type SandboxHydrationTiming = {
  totalMs: number;
  e2bConnectOrCreateMs?: number;
  prepareWorkspaceMs?: number;
  materializeBrainMs?: number;
  materializeAgentBundleMs?: number;
  materializeSkillsMs?: number;
  materializeAttachmentsMs?: number;
};

export async function ensureSandbox(
  row: LoadedSession,
  env: RunnerEnv,
  options?: { braintrustSpan?: BraintrustSpan | undefined },
) {
  let sandbox: SandboxHandle | null = null;
  const agentConfig = normalizeAgentConfig(row.agent.config);
  // The user's personal/default agent gets the memory/ + personal-brain/ + work/ sandbox layout and
  // no company brain mount; company/workspace agents keep the original agent/ + brain/ + work/ tree.
  const personal = row.agent.isDefault;
  const template = resolveSandboxTemplate(agentConfig, env);
  const existingSandbox = Boolean(row.session.e2bSandboxId);
  const readyStartedAt = performance.now();
  const timings: Partial<SandboxHydrationTiming> = {};
  const e2bRequests: SandboxLatencyObservation[] = [];
  try {
    // Each hydration stage gets its own Braintrust child span (under the caller's
    // ensure_sandbox span) so a slow first tool call is attributable to connect/resume vs the
    // sequential e2b prep/materialize round-trips. No-ops when Braintrust is disabled.
    sandbox = await traceBraintrustStep(
      "sandbox_connect_or_create",
      () =>
        recordSandboxHydrationStage(timings, "e2bConnectOrCreateMs", () =>
          createOrConnectSandbox({
            sandboxId: row.session.e2bSandboxId,
            template,
            // With the LLM broker active nothing in the sandbox needs platform keys:
            // tools that call models receive short-lived broker tokens per delegation
            // (opencode-tool.ts, memory-tool.ts). The legacy global injection remains
            // only for the non-brokered fallback (local dev, kill switch) — it is the
            // exact exposure the broker exists to remove.
            envs: brokerActive(env)
              ? {}
              : {
                  E2B_API_KEY: env.e2bApiKey,
                  VERCEL_AI_GATEWAY_API_KEY: env.vercelAiGatewayApiKey,
                },
            idleTimeoutMs: env.e2bSandboxIdleTimeoutMs,
            onLatency: (observation) => {
              e2bRequests.push(observation);
              captureE2BSandboxLatency({
                row,
                template,
                existingSandbox,
                phase: "e2b_request",
                ...observation,
              });
            },
          }),
        ),
      { existing_sandbox: existingSandbox, template: template ?? "default" },
    );
    const readySandbox = sandbox;
    await traceBraintrustStep("sandbox_prepare_workspace", () =>
      recordSandboxHydrationStage(timings, "prepareWorkspaceMs", () =>
        prepareWorkspace({
          sandbox: readySandbox,
          workdir: row.session.workdir,
          personal,
          configureGitCredentialHelper: needsAuthenticatedGit(agentConfig),
          agentFile: serializeAgentFile({
            title: agentConfig.title,
            body: agentConfig.instructions,
            engine: agentConfig.engine,
            model: agentConfig.model.name,
            tools: agentConfig.tools,
            brain: agentConfig.brain,
            skills: agentConfig.skills ?? [],
            integrations: agentConfig.integrations,
            triggers: agentConfig.triggers,
          }),
        }),
      ),
    );
    // Personal agents have no company brain mount — skip materializing ./brain for them.
    const materializationTasks: Promise<unknown>[] = [];
    if (!personal) {
      materializationTasks.push(
        traceBraintrustStep("sandbox_materialize_brain", () =>
          recordSandboxHydrationStage(timings, "materializeBrainMs", () =>
            materializeBrainForSession({
              sandbox: readySandbox,
              sessionId: row.session.id,
              workspaceId: row.workspace.id,
              workdir: row.session.workdir,
              references: agentConfig.brain,
            }),
          ),
        ),
      );
    }
    materializationTasks.push(
      traceBraintrustStep("sandbox_materialize_agent_bundle", () =>
        recordSandboxHydrationStage(timings, "materializeAgentBundleMs", () =>
          materializeAgentBundleForSession({
            sandbox: readySandbox,
            sessionId: row.session.id,
            workspaceId: row.workspace.id,
            agentId: row.agent.id,
            workdir: row.session.workdir,
            personal,
          }),
        ),
      ),
    );
    materializationTasks.push(
      traceBraintrustStep("sandbox_materialize_skills", () =>
        recordSandboxHydrationStage(timings, "materializeSkillsMs", () =>
          materializeSkillsForSession({
            sandbox: readySandbox,
            workdir: row.session.workdir,
            workspaceId: row.workspace.id,
            agentId: row.agent.id,
            config: agentConfig,
          }),
        ),
      ),
    );
    // Above-threshold text attachments are path-referenced in the model history instead of
    // inlined, so they must exist in the workspace on every acquire (survives recycles).
    // Never throws — a failure degrades to the inline preview, not a failed sandbox.
    materializationTasks.push(
      traceBraintrustStep("sandbox_materialize_attachments", () =>
        recordSandboxHydrationStage(timings, "materializeAttachmentsMs", () =>
          materializeLargeTextAttachmentsForSession({
            sandbox: readySandbox,
            sessionId: row.session.id,
            workdir: row.session.workdir,
            blobToken: env.blobReadWriteToken,
          }),
        ),
      ),
    );
    await waitForMaterializationTasks(materializationTasks);
    const totalMs = elapsedMs(readyStartedAt);
    captureE2BSandboxLatency({
      row,
      template,
      existingSandbox,
      phase: "sandbox_ready",
      operation: "hydrate",
      outcome: "success",
      latencyMs: totalMs,
      sandboxId: sandbox.sandboxId,
      ...(row.session.e2bSandboxId ? { requestedSandboxId: row.session.e2bSandboxId } : {}),
    });
    logSandboxHydrationTiming(options?.braintrustSpan, {
      outcome: "success",
      existingSandbox,
      template: template ?? "default",
      timings: { ...timings, totalMs },
      e2bRequests,
      sandboxId: sandbox.sandboxId,
      ...(row.session.e2bSandboxId ? { requestedSandboxId: row.session.e2bSandboxId } : {}),
    });
    return sandbox;
  } catch (error) {
    const name = errorName(error);
    const totalMs = elapsedMs(readyStartedAt);
    captureE2BSandboxLatency({
      row,
      template,
      existingSandbox,
      phase: "sandbox_ready",
      operation: "hydrate",
      outcome: "error",
      latencyMs: totalMs,
      ...(sandbox ? { sandboxId: sandbox.sandboxId } : {}),
      ...(row.session.e2bSandboxId ? { requestedSandboxId: row.session.e2bSandboxId } : {}),
      ...(name ? { errorName: name } : {}),
    });
    logSandboxHydrationTiming(options?.braintrustSpan, {
      outcome: "error",
      existingSandbox,
      template: template ?? "default",
      timings: { ...timings, totalMs },
      e2bRequests,
      ...(sandbox ? { sandboxId: sandbox.sandboxId } : {}),
      ...(row.session.e2bSandboxId ? { requestedSandboxId: row.session.e2bSandboxId } : {}),
      ...(name ? { errorName: name } : {}),
    });
    captureException(error, {
      event: "opencompany.runner_sandbox_failed",
      workspace_id: row.workspace.id,
      user_id: row.session.userId,
      agent_id: row.agent.id,
      session_id: row.session.id,
      sandbox_id: sandbox?.sandboxId ?? row.session.e2bSandboxId,
      existing_sandbox: Boolean(row.session.e2bSandboxId),
      ...sandboxPreparationErrorFields(error),
    });
    if (sandbox) {
      await parkSandboxWhenIdle(sandbox, env);
    }
    throw error;
  }
}

export async function acquireCodexSandboxForTurn(
  row: LoadedSession,
  env: RunnerEnv,
  options?: { braintrustSpan?: BraintrustSpan | undefined },
) {
  const requestedSandboxId = row.session.e2bSandboxId;
  if (!requestedSandboxId) {
    return ensureSandbox(row, env, options);
  }

  const agentConfig = normalizeAgentConfig(row.agent.config);
  const template = resolveSandboxTemplate(agentConfig, env);
  const readyStartedAt = performance.now();
  const e2bRequests: SandboxLatencyObservation[] = [];
  try {
    const sandbox = await connectSandbox({
      sandboxId: requestedSandboxId,
      onLatency: (observation) => {
        e2bRequests.push(observation);
        captureE2BSandboxLatency({
          row,
          template,
          existingSandbox: true,
          phase: "e2b_request",
          ...observation,
        });
      },
    });

    if (!sandbox) {
      return ensureSandbox(
        { ...row, session: { ...row.session, e2bSandboxId: null } },
        env,
        options,
      );
    }

    const totalMs = elapsedMs(readyStartedAt);
    captureE2BSandboxLatency({
      row,
      template,
      existingSandbox: true,
      phase: "sandbox_ready",
      operation: "connect",
      outcome: "success",
      latencyMs: totalMs,
      sandboxId: sandbox.sandboxId,
      requestedSandboxId,
    });
    logSandboxHydrationTiming(options?.braintrustSpan, {
      outcome: "success",
      existingSandbox: true,
      template: template ?? "default",
      timings: { totalMs },
      e2bRequests,
      sandboxId: sandbox.sandboxId,
      requestedSandboxId,
    });
    return sandbox;
  } catch (error) {
    const name = errorName(error);
    const totalMs = elapsedMs(readyStartedAt);
    captureE2BSandboxLatency({
      row,
      template,
      existingSandbox: true,
      phase: "sandbox_ready",
      operation: "connect",
      outcome: "error",
      latencyMs: totalMs,
      requestedSandboxId,
      ...(name ? { errorName: name } : {}),
    });
    logSandboxHydrationTiming(options?.braintrustSpan, {
      outcome: "error",
      existingSandbox: true,
      template: template ?? "default",
      timings: { totalMs },
      e2bRequests,
      requestedSandboxId,
      ...(name ? { errorName: name } : {}),
    });
    captureException(error, {
      event: "opencompany.runner_sandbox_failed",
      workspace_id: row.workspace.id,
      user_id: row.session.userId,
      agent_id: row.agent.id,
      session_id: row.session.id,
      sandbox_id: requestedSandboxId,
      existing_sandbox: true,
    });
    throw error;
  }
}

function captureE2BSandboxLatency(input: {
  row: LoadedSession;
  phase: "e2b_request" | "sandbox_ready";
  operation: "create" | "connect" | "hydrate";
  outcome: "success" | "not_found" | "error";
  latencyMs: number;
  template: string | null | undefined;
  existingSandbox: boolean;
  sandboxId?: string;
  requestedSandboxId?: string;
  errorName?: string;
}) {
  try {
    void captureServerEvent("e2b_sandbox_latency", input.row.session.userId, {
      user_id: input.row.session.userId,
      workspace_id: input.row.workspace.id,
      agent_id: input.row.agent.id,
      session_id: input.row.session.id,
      phase: input.phase,
      operation: input.operation,
      outcome: input.outcome,
      latency_ms: input.latencyMs,
      existing_sandbox: input.existingSandbox,
      template: input.template ?? "default",
      ...(input.sandboxId ? { sandbox_id: input.sandboxId } : {}),
      ...(input.requestedSandboxId ? { requested_sandbox_id: input.requestedSandboxId } : {}),
      ...(input.errorName ? { error_name: input.errorName } : {}),
    }).catch(() => {});
  } catch {
    // Analytics must not affect sandbox provisioning.
  }
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function recordSandboxHydrationStage<T>(
  timings: Partial<SandboxHydrationTiming>,
  stage: Exclude<keyof SandboxHydrationTiming, "totalMs">,
  run: () => Promise<T>,
) {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    timings[stage] = elapsedMs(startedAt);
  }
}

async function waitForMaterializationTasks(tasks: Promise<unknown>[]) {
  const results = await Promise.allSettled(tasks);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
}

function logSandboxHydrationTiming(
  span: BraintrustSpan | undefined,
  input: {
    outcome: "success" | "error";
    existingSandbox: boolean;
    template: string;
    timings: Partial<SandboxHydrationTiming> & Pick<SandboxHydrationTiming, "totalMs">;
    e2bRequests: SandboxLatencyObservation[];
    sandboxId?: string;
    requestedSandboxId?: string;
    errorName?: string;
  },
) {
  logBraintrustSpan(span, {
    metrics: sandboxHydrationMetrics(input.timings, input.e2bRequests),
    metadata: {
      sandbox_hydration_outcome: input.outcome,
      sandbox_existing: input.existingSandbox,
      sandbox_template: input.template,
      ...(input.sandboxId ? { sandbox_id: input.sandboxId } : {}),
      ...(input.requestedSandboxId ? { requested_sandbox_id: input.requestedSandboxId } : {}),
      ...(input.errorName ? { error_name: input.errorName } : {}),
      ...(input.e2bRequests.length
        ? {
            sandbox_e2b_requests: input.e2bRequests.map((request) => ({
              operation: request.operation,
              outcome: request.outcome,
              latency_ms: request.latencyMs,
              ...(request.sandboxId ? { sandbox_id: request.sandboxId } : {}),
              ...(request.requestedSandboxId
                ? { requested_sandbox_id: request.requestedSandboxId }
                : {}),
              ...(request.errorName ? { error_name: request.errorName } : {}),
            })),
          }
        : {}),
    },
  });
}

function sandboxHydrationMetrics(
  timings: Partial<SandboxHydrationTiming> & Pick<SandboxHydrationTiming, "totalMs">,
  e2bRequests: SandboxLatencyObservation[],
) {
  const metrics: Record<string, number> = {
    sandbox_hydration_total_ms: timings.totalMs,
  };
  addMetric(metrics, "sandbox_hydration_e2b_connect_or_create_ms", timings.e2bConnectOrCreateMs);
  addMetric(metrics, "sandbox_hydration_prepare_workspace_ms", timings.prepareWorkspaceMs);
  addMetric(metrics, "sandbox_hydration_materialize_brain_ms", timings.materializeBrainMs);
  addMetric(
    metrics,
    "sandbox_hydration_materialize_agent_bundle_ms",
    timings.materializeAgentBundleMs,
  );
  addMetric(metrics, "sandbox_hydration_materialize_skills_ms", timings.materializeSkillsMs);
  addMetric(
    metrics,
    "sandbox_hydration_materialize_attachments_ms",
    timings.materializeAttachmentsMs,
  );
  for (const request of e2bRequests) {
    addMetric(metrics, `sandbox_e2b_${request.operation}_ms`, request.latencyMs);
  }
  return metrics;
}

function addMetric(metrics: Record<string, number>, name: string, value: number | undefined) {
  if (value === undefined) return;
  metrics[name] = value;
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : undefined;
}

// The richer sandbox template (with git, gh, and the coding-agent CLIs installed)
// is used whenever the agent has GitHub access (an attached repository or the live
// `@github` all-repositories scope) or a coding-agent tool enabled; plain chat agents
// get the lighter default template.
function resolveSandboxTemplate(agentConfig: AgentConfig, env: RunnerEnv) {
  return agentConfig.engine === "codex" || needsAuthenticatedGit(agentConfig)
    ? (env.ampE2bTemplate ?? "amp")
    : env.e2bTemplate;
}

function needsAuthenticatedGit(agentConfig: AgentConfig) {
  return (
    agentHasGitHubAccess(agentConfig) ||
    agentConfig.tools.some(
      (tool) => tool.id === "amp" || tool.id === "opencode" || tool.id === "codex",
    )
  );
}

// Per-template resource overrides used to price sandbox compute. Both current templates
// run on E2B's base allocation; add an entry here if a template is ever provisioned with
// a custom vCPU/RAM size so billing tracks the real allocation.
const SANDBOX_TEMPLATE_RESOURCES: Record<string, SandboxResourceConfig> = {};

export type SandboxBillingInfo = {
  template: string | null;
  vcpu: number;
  ramMib: number;
};

// Resolve the template + resource allocation a session's sandbox runs on, for billing.
// Deterministic from the session row + env, so the run lifecycle can compute it without
// touching E2B.
export function resolveSandboxBilling(row: LoadedSession, env: RunnerEnv): SandboxBillingInfo {
  const agentConfig = normalizeAgentConfig(row.agent.config);
  const template = resolveSandboxTemplate(agentConfig, env) ?? null;
  const resources =
    (template ? SANDBOX_TEMPLATE_RESOURCES[template] : undefined) ?? DEFAULT_SANDBOX_RESOURCES;
  return { template, vcpu: resources.vcpu, ramMib: resources.ramMiB };
}

export async function parkSandboxWhenIdle(sandbox: SandboxHandle, env: RunnerEnv) {
  try {
    const armed = await armSandboxIdleTimeout(sandbox, env.e2bSandboxIdleTimeoutMs);
    if (!armed) {
      logger.warn("E2B sandbox was gone before idle timeout could be armed", {
        sandbox_id: sandbox.sandboxId,
      });
    }
  } catch (error) {
    logger.warn("Failed to arm E2B sandbox idle timeout", {
      sandbox_id: sandbox.sandboxId,
      error,
    });
  }
}

export async function loadSession(sessionId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      session: agentSessions,
      agent: agents,
      workspace: workspaces,
      user: users,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .innerJoin(workspaces, eq(agentSessions.workspaceId, workspaces.id))
    .innerJoin(users, eq(agentSessions.userId, users.id))
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const [repository] = await db
    .select()
    .from(workspaceRepositories)
    .where(eq(workspaceRepositories.workspaceId, row.workspace.id))
    .limit(1);

  return { ...row, repository: repository ?? null };
}

export function optionalUserContext(
  user: Pick<typeof users.$inferSelect, "email" | "firstName" | "lastName">,
) {
  const userName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return {
    ...(userName ? { userName } : {}),
    ...(user.firstName ? { userFirstName: user.firstName } : {}),
    ...(user.lastName ? { userLastName: user.lastName } : {}),
    ...(user.email ? { userEmail: user.email } : {}),
  };
}

export type LoadedSession = Awaited<ReturnType<typeof loadSession>>;

export async function loadUserMessage(sessionId: string, messageId: string) {
  const [message] = await getDb()
    .select({ id: agentSessionMessages.id, createdAt: agentSessionMessages.createdAt })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.id, messageId),
        eq(agentSessionMessages.sessionId, sessionId),
        eq(agentSessionMessages.role, "user"),
        eq(agentSessionMessages.internal, false),
      ),
    )
    .limit(1);

  return message ?? null;
}

// `notExists` clause shared by every pending-message lookup below: true when no assistant
// message in this session has responded to the candidate user message yet. Each call builds
// its own alias so the subquery can be composed into independent top-level queries.
function noResponseYet(sessionId: string) {
  const responses = alias(agentSessionMessages, "pending_responses");
  return notExists(
    getDb()
      .select({ value: sql`1` })
      .from(responses)
      .where(
        and(
          eq(responses.sessionId, sessionId),
          eq(responses.responseToMessageId, agentSessionMessages.id),
        ),
      ),
  );
}

// Early-stop signal: the oldest unanswered user message sent in "steer" mode (or a legacy
// NULL send, which behaves as steer) after `afterCreatedAt`. The turn's extraStopConditions
// polls this to end the active turn at the next model-step boundary. "queue" messages are
// excluded so the active turn runs all its steps first; "interrupt" messages travel the abort
// path instead. See docs/agent-turn-vocabulary.md.
export async function loadNextSteerMessage(input: { sessionId: string; afterCreatedAt: Date }) {
  const [message] = await getDb()
    .select({
      id: agentSessionMessages.id,
      createdAt: agentSessionMessages.createdAt,
    })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, input.sessionId),
        eq(agentSessionMessages.role, "user"),
        eq(agentSessionMessages.internal, false),
        gt(agentSessionMessages.createdAt, input.afterCreatedAt),
        or(eq(agentSessionMessages.sendMode, "steer"), isNull(agentSessionMessages.sendMode)),
        noResponseYet(input.sessionId),
      ),
    )
    .orderBy(asc(agentSessionMessages.createdAt))
    .limit(1);

  return message ?? null;
}

// Turn-completion pickup: the oldest unanswered user message of ANY send-mode after
// `afterCreatedAt`. Once a turn ends naturally, both "steer" and "queue" messages drain here
// in FIFO order, each answered as its own subsequent turn.
export async function loadNextPendingMessage(input: { sessionId: string; afterCreatedAt: Date }) {
  const [message] = await getDb()
    .select({
      id: agentSessionMessages.id,
      createdAt: agentSessionMessages.createdAt,
      sendMode: agentSessionMessages.sendMode,
    })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, input.sessionId),
        eq(agentSessionMessages.role, "user"),
        eq(agentSessionMessages.internal, false),
        gt(agentSessionMessages.createdAt, input.afterCreatedAt),
        noResponseYet(input.sessionId),
      ),
    )
    .orderBy(asc(agentSessionMessages.createdAt))
    .limit(1);

  return message ?? null;
}

// Abort-path continuation: the newest unanswered "interrupt" message other than the one whose
// turn just aborted. After a run aborts because the user chose Interrupt and sent a new message,
// the outer turn loop runs this next — ahead of any queued messages, since interrupt means "do
// this now". Excluding `abortedMessageId` matters when the aborted turn was itself started by an
// interrupt message: a plain Stop of such a turn (no new message) must not re-run it, and
// interrupting-an-interrupt must run the latest one, not the abandoned earlier one.
export async function loadPendingInterruptMessage(input: {
  sessionId: string;
  abortedMessageId: string;
}) {
  const [message] = await getDb()
    .select({ id: agentSessionMessages.id })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, input.sessionId),
        eq(agentSessionMessages.role, "user"),
        eq(agentSessionMessages.internal, false),
        eq(agentSessionMessages.sendMode, "interrupt"),
        ne(agentSessionMessages.id, input.abortedMessageId),
        noResponseYet(input.sessionId),
      ),
    )
    .orderBy(desc(agentSessionMessages.createdAt))
    .limit(1);

  return message ?? null;
}

export async function loadLatestUserMessage(sessionId: string) {
  const [message] = await getDb()
    .select({ id: agentSessionMessages.id })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, sessionId),
        eq(agentSessionMessages.role, "user"),
        eq(agentSessionMessages.internal, false),
      ),
    )
    .orderBy(desc(agentSessionMessages.createdAt))
    .limit(1);

  return message ?? null;
}

export async function loadAssistantResponseForMessage(sessionId: string, messageId: string) {
  const [message] = await getDb()
    .select({
      id: agentSessionMessages.id,
      status: agentSessionMessages.status,
      content: agentSessionMessages.content,
    })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, sessionId),
        eq(agentSessionMessages.responseToMessageId, messageId),
      ),
    )
    .limit(1);

  return message ?? null;
}

export async function createAfterSessionRun(input: {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  lastUserMessageId: string;
  agentVersion: number;
  runLeaseId: string;
}) {
  const [run] = await getDb()
    .insert(agentSessionAfterSessionRuns)
    .values({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      lastUserMessageId: input.lastUserMessageId,
      agentVersion: input.agentVersion,
      status: "running",
      runLeaseId: input.runLeaseId,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        agentSessionAfterSessionRuns.sessionId,
        agentSessionAfterSessionRuns.lastUserMessageId,
        agentSessionAfterSessionRuns.agentVersion,
      ],
    })
    .returning({ id: agentSessionAfterSessionRuns.id });

  return run ?? null;
}

// Marks an after-session run as having spawned a dedicated memory-keeper session, linking to it for
// auditability. The keeper then runs as its own session; this run record's job is done.
export async function markAfterSessionRunSpawned(id: number, childSessionId: string) {
  await getDb()
    .update(agentSessionAfterSessionRuns)
    .set({
      status: "spawned",
      childSessionId,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentSessionAfterSessionRuns.id, id));
}

// Collapse a memory pass's closing note into a single short line safe to embed in the parent's
// `after_session.completed` event payload (the web surfaces it as the memory card's result).
export function summarizeAfterSessionNote(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > 280 ? `${collapsed.slice(0, 277)}...` : collapsed;
}

export async function completeSpawnedAfterSessionRunForChild(input: {
  childSessionId: string;
  status: "completed" | "failed";
  lastError?: string;
  // One-line summary of what the memory pass stored (the keeper's closing note).
  summary?: string;
}) {
  const db = getDb();
  const [run] = await db
    .select({
      id: agentSessionAfterSessionRuns.id,
      sessionId: agentSessionAfterSessionRuns.sessionId,
      lastUserMessageId: agentSessionAfterSessionRuns.lastUserMessageId,
      status: agentSessionAfterSessionRuns.status,
    })
    .from(agentSessionAfterSessionRuns)
    .where(eq(agentSessionAfterSessionRuns.childSessionId, input.childSessionId))
    .limit(1);

  if (!run || run.status === input.status) return null;
  if (run.status !== "spawned" && run.status !== "running") return null;

  await db
    .update(agentSessionAfterSessionRuns)
    .set({
      status: input.status,
      lastError: input.status === "failed" ? (input.lastError ?? null) : null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentSessionAfterSessionRuns.id, run.id));

  if (input.status === "completed") {
    await appendRuntimeEvent(db, {
      sessionId: run.sessionId,
      type: "after_session.completed",
      payload: {
        runId: run.id,
        messageId: run.lastUserMessageId,
        childSessionId: input.childSessionId,
        ...(input.summary ? { summary: input.summary } : {}),
      },
    });
  } else {
    await appendRuntimeEvent(db, {
      sessionId: run.sessionId,
      type: "after_session.failed",
      payload: {
        runId: run.id,
        messageId: run.lastUserMessageId,
        childSessionId: input.childSessionId,
        message: input.lastError ?? "Memory update failed.",
      },
    });
  }

  return run;
}

export async function completeAfterSessionRun(
  id: number,
  input: { status: "completed" | "skipped" | "failed"; skippedReason?: string; lastError?: string },
) {
  await getDb()
    .update(agentSessionAfterSessionRuns)
    .set({
      status: input.status,
      skippedReason: input.skippedReason ?? null,
      lastError: input.lastError ?? null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentSessionAfterSessionRuns.id, id));
}

export async function appendAfterSessionSkipped(input: {
  sessionId: string;
  messageId: string;
  reason: string;
}) {
  await appendRuntimeEvent(getDb(), {
    sessionId: input.sessionId,
    type: "after_session.skipped",
    payload: { messageId: input.messageId, reason: input.reason },
  });
}

export function buildAfterSessionPrompt(input: { prompt: string }) {
  return `After-session instructions:\n${input.prompt}`;
}

export async function setStatus(sessionId: string, status: "provisioning" | "ready" | "completed") {
  const [updated] = await getDb()
    .update(agentSessions)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        isNull(agentSessions.archivedAt),
        isNull(agentSessions.runLeaseId),
      ),
    )
    .returning({ id: agentSessions.id });

  return Boolean(updated);
}

export async function isSessionArchived(sessionId: string) {
  const [session] = await getDb()
    .select({ archivedAt: agentSessions.archivedAt })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  return Boolean(session?.archivedAt);
}

export async function startSession(sessionId: string, env: RunnerEnv) {
  const db = getDb();
  const row = await loadSession(sessionId);
  if (row.session.archivedAt) return;

  if (!(await setStatus(sessionId, "provisioning"))) return;
  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "provisioning", message: "Starting sandbox" },
  });

  const sandbox = await ensureSandbox(row, env);
  const [updated] = await db
    .update(agentSessions)
    .set({
      e2bSandboxId: sandbox.sandboxId,
      status: "ready",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.status, "provisioning"),
        isNull(agentSessions.archivedAt),
        isNull(agentSessions.runLeaseId),
      ),
    )
    .returning({ id: agentSessions.id });
  if (!updated) {
    await killSandbox(sandbox.sandboxId);
    return;
  }

  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "ready", message: "Sandbox ready" },
  });
  logger.info("Runner session ready", {
    event: "opencompany.runner_session_ready",
    workspace_id: row.workspace.id,
    user_id: row.session.userId,
    agent_id: row.agent.id,
    session_id: sessionId,
    sandbox_id: sandbox.sandboxId,
  });
  await parkSandboxWhenIdle(sandbox, env);
}

export async function abortSession(sessionId: string) {
  const db = getDb();
  const [updated] = await db
    .update(agentSessions)
    .set({
      status: "aborting",
      abortRequestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.archivedAt)))
    .returning({ id: agentSessions.id });
  if (!updated) return;

  abortActiveRun(sessionId);
  // If the session was paused at an "ask" gate there is no active run to abort, and a
  // still-pending approval would later be swept (auto-denied) and resumed — reviving an
  // aborted session. Deny any pending approvals now so no resume can fire. The dangling
  // tool-call in the suspended assistant message is dropped by buildModelMessages, so the
  // history stays valid for any future turn.
  await db
    .update(agentToolApprovals)
    .set({
      status: "denied",
      decisionSource: "abort",
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(agentToolApprovals.sessionId, sessionId), eq(agentToolApprovals.status, "pending")),
    );
  // Same hazard for a session paused on an ask_user_question: cancel any pending question so the
  // backstop can't revive the aborted session via a question resume.
  const cancelledQuestions = await db
    .update(agentSessionQuestions)
    .set({
      status: "cancelled",
      resolutionSource: "abort",
      answeredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessionQuestions.sessionId, sessionId),
        eq(agentSessionQuestions.status, "pending"),
      ),
    )
    .returning({
      toolCallId: agentSessionQuestions.toolCallId,
      messageId: agentSessionQuestions.messageId,
    });
  // The web reducer only moves a question card out of its interactive `pending` state on a
  // `question.answered` event, so without this the aborted session would keep rendering a live
  // question card. Emit the resolution event the resume path would have produced.
  for (const question of cancelledQuestions) {
    const messageId = question.messageId ?? "";
    await appendRuntimeEvent(db, {
      sessionId,
      messageId,
      type: "question.answered",
      payload: {
        messageId,
        toolCallId: question.toolCallId,
        answered: false,
        answers: [],
        resolutionSource: "abort",
      },
    });
  }
  // Revoke + settle any outstanding LLM-broker tokens so an aborted delegation's metered
  // spend is billed now instead of waiting for the expiry sweeper. Best-effort: the
  // settlement CAS makes a race with the tool's own finally block harmless.
  try {
    await settleBrokerTokensForSession(sessionId);
  } catch (error) {
    logger.warn("Failed to settle broker tokens on abort", {
      event: "opencompany.llm_broker_abort_settle_failed",
      session_id: sessionId,
      error,
    });
  }
  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "aborting", message: "Abort requested" },
  });
  logger.info("Runner session abort requested", {
    event: "opencompany.runner_session_abort_requested",
    session_id: sessionId,
  });
}

export async function archiveSession(sessionId: string) {
  const db = getDb();
  abortActiveRun(sessionId);

  const [session] = await db
    .select({
      id: agentSessions.id,
      e2bSandboxId: agentSessions.e2bSandboxId,
      archivedAt: agentSessions.archivedAt,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (session.archivedAt) return;

  // Settle outstanding LLM-broker tokens before the archive transaction so the billable
  // settlement row + its session.tool_usage event land while the session (and its
  // Durable Stream) are still open. CAS-idempotent against the tool's own finally block.
  try {
    await settleBrokerTokensForSession(sessionId);
  } catch (error) {
    logger.warn("Failed to settle broker tokens on archive", {
      event: "opencompany.llm_broker_archive_settle_failed",
      session_id: sessionId,
      error,
    });
  }

  const previousSandboxId = session.e2bSandboxId;
  const sandboxKilled = previousSandboxId ? await killSandbox(previousSandboxId) : false;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(agentSessions)
      .set({
        status: "archived",
        archivedAt: now,
        sandboxTerminatedAt: now,
        e2bSandboxId: null,
        runLeaseId: null,
        runLeaseOwner: null,
        runLeaseMessageId: null,
        runLeaseExpiresAt: null,
        runHeartbeatAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(agentSessions.id, sessionId));
    await tx.insert(agentSessionEvents).values({
      sessionId,
      type: "session.status",
      payload: { status: "archived", message: "Session archived" },
    });
    await tx.insert(agentSessionEvents).values({
      sessionId,
      type: "session.archived",
      payload: {
        sandboxId: previousSandboxId,
        sandboxKilled,
        sandboxAlreadyStopped: previousSandboxId === null || !sandboxKilled,
      },
    });
  });

  // The session is permanently archived — no future turn can append, so this is the
  // one provably-safe point to close the Durable Stream (EOF). Best-effort; Postgres
  // remains the system of record.
  await closeSessionStream(sessionId);
}
