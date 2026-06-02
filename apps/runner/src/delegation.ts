import {
  newAgentSessionId,
  newAgentSessionMessageId,
  normalizeAgentConfig,
} from "@opencompany/agent-runtime";
import type { AgentReference } from "@opencompany/agent-runtime/types";
import { agentSessionEvents, agentSessionMessages, agentSessions, agents } from "@opencompany/db/schema";
import { traceBraintrustStep } from "@opencompany/observability/braintrust";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { emitDelegatedUsageRollupForLease } from "./delegation-usage";
import type { RunnerEnv } from "./env";
import type { RunControlCheck } from "./run-control";
import { loadAssistantResponseForMessage } from "./session-lifecycle";

const MAX_AGENT_DELEGATION_DEPTH = 2;

type DelegatedChildRunResult = { ok: boolean; status: string; error?: string };

// Runs a delegated child turn. Injected from the runner module so this file stays free of any
// dependency on `runMessage` (which would otherwise form an import cycle through agent-loop.ts).
export type RunDelegatedChildMessage = (input: {
  sessionId: string;
  messageId: string;
  env: RunnerEnv;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  depth: number;
}) => Promise<DelegatedChildRunResult | null>;

export function createAgentDelegationHandler(input: {
  parentSessionId: string;
  parentMessageId: string;
  parentRunLeaseId: string;
  parentRunLeaseOwner: string;
  workspaceId: string;
  userId: string;
  env: RunnerEnv;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  depth: number;
  agentReferences: AgentReference[];
  runChildMessage: RunDelegatedChildMessage;
}) {
  const runChildMessage = input.runChildMessage;
  return async ({
    agent,
    sessionId,
    prompt,
    toolCallId,
  }: {
    agent?: string;
    sessionId?: string;
    prompt: string;
    toolCallId: string;
  }) => {
    if (input.depth >= MAX_AGENT_DELEGATION_DEPTH) {
      return {
        ok: false,
        status: "failed",
        error: `Agent delegation depth limit of ${MAX_AGENT_DELEGATION_DEPTH} was reached.`,
      };
    }

    if (sessionId) {
      return resumeDelegatedAgentSession({
        childSessionId: sessionId,
        prompt,
        parentSessionId: input.parentSessionId,
        parentMessageId: input.parentMessageId,
        parentRunLeaseId: input.parentRunLeaseId,
        parentRunLeaseOwner: input.parentRunLeaseOwner,
        parentToolCallId: toolCallId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        env: input.env,
        signal: input.signal,
        checkAbort: input.checkAbort,
        depth: input.depth,
        runChildMessage,
      });
    }

    if (!agent) {
      return {
        ok: false,
        status: "failed",
        error: "Agent is required when starting a delegated session.",
      };
    }

    const targetReference = resolveDelegatedAgentReference(agent, input.agentReferences);
    if (!targetReference) {
      return {
        ok: false,
        status: "failed",
        error: `Agent ${agent} is not configured for delegation in this agent.`,
      };
    }

    const target = await loadDelegatedAgent(input.workspaceId, targetReference.path);
    if (!target) {
      return {
        ok: false,
        status: "failed",
        agentPath: targetReference.path,
        error: `Agent ${targetReference.path} was not found in this workspace.`,
      };
    }

    const childSessionId = newAgentSessionId();
    const childMessageId = newAgentSessionMessageId();
    await createDelegatedAgentSession({
      sessionId: childSessionId,
      messageId: childMessageId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: target.id,
      agentName: target.name,
      modelProvider: target.config.model.provider,
      modelName: target.config.model.name,
      prompt,
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      toolCallId,
    });

    const runResult = await traceBraintrustStep(
      "delegate_to_agent.run_child_message",
      () =>
        runChildMessage({
          sessionId: childSessionId,
          messageId: childMessageId,
          env: input.env,
          signal: input.signal,
          checkAbort: input.checkAbort,
          depth: input.depth,
        }),
      {
        parent_session_id: input.parentSessionId,
        parent_message_id: input.parentMessageId,
        child_session_id: childSessionId,
        child_message_id: childMessageId,
        child_agent_id: target.id,
        child_agent_path: target.path,
        tool_call_id: toolCallId,
        delegation_depth: input.depth + 1,
      },
    );
    if (runResult) {
      await emitDelegatedUsageRollupForLease({
        parentSessionId: input.parentSessionId,
        parentMessageId: input.parentMessageId,
        parentRunLeaseId: input.parentRunLeaseId,
        parentRunLeaseOwner: input.parentRunLeaseOwner,
        childSessionId,
        parentToolCallId: toolCallId,
      });
      return {
        ...runResult,
        childSessionId,
        agentName: target.name,
        agentPath: target.path,
      };
    }

    const assistant = await loadAssistantResponseForMessage(childSessionId, childMessageId);
    if (!assistant?.content.trim()) {
      await emitDelegatedUsageRollupForLease({
        parentSessionId: input.parentSessionId,
        parentMessageId: input.parentMessageId,
        parentRunLeaseId: input.parentRunLeaseId,
        parentRunLeaseOwner: input.parentRunLeaseOwner,
        childSessionId,
        parentToolCallId: toolCallId,
      });
      return {
        ok: false,
        status: "failed",
        childSessionId,
        agentName: target.name,
        agentPath: target.path,
        error: "Delegated agent completed without a final answer.",
      };
    }

    await emitDelegatedUsageRollupForLease({
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      parentRunLeaseId: input.parentRunLeaseId,
      parentRunLeaseOwner: input.parentRunLeaseOwner,
      childSessionId,
      parentToolCallId: toolCallId,
    });

    return {
      ok: true,
      status: "completed",
      childSessionId,
      agentName: target.name,
      agentPath: target.path,
      answer: assistant.content,
    };
  };
}

async function resumeDelegatedAgentSession(input: {
  childSessionId: string;
  prompt: string;
  parentSessionId: string;
  parentMessageId: string;
  parentRunLeaseId: string;
  parentRunLeaseOwner: string;
  parentToolCallId: string;
  workspaceId: string;
  userId: string;
  env: RunnerEnv;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  depth: number;
  runChildMessage: RunDelegatedChildMessage;
}) {
  const child = await loadDelegatedChildSession({
    sessionId: input.childSessionId,
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  if (!child) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      error: `Delegated child session ${input.childSessionId} was not found.`,
    };
  }
  if (child.parentSessionId !== input.parentSessionId) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      error: `Session ${input.childSessionId} is not a child session of this agent session.`,
    };
  }
  if (child.archivedAt) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      agentName: child.agentName,
      agentPath: child.agentPath,
      error: `Delegated child session ${input.childSessionId} is archived.`,
    };
  }
  if (isDelegatedChildSessionBusy(child)) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      agentName: child.agentName,
      agentPath: child.agentPath,
      error: `Delegated child session ${input.childSessionId} is already running.`,
    };
  }

  const childMessageId = await appendDelegatedChildUserMessage({
    sessionId: input.childSessionId,
    prompt: input.prompt,
  });

  const runResult = await traceBraintrustStep(
    "delegate_to_agent.resume_child_message",
    () =>
      input.runChildMessage({
        sessionId: input.childSessionId,
        messageId: childMessageId,
        env: input.env,
        signal: input.signal,
        checkAbort: input.checkAbort,
        depth: input.depth,
      }),
    {
      parent_session_id: input.parentSessionId,
      parent_message_id: input.parentMessageId,
      child_session_id: input.childSessionId,
      child_message_id: childMessageId,
      tool_call_id: input.parentToolCallId,
      delegation_depth: input.depth + 1,
    },
  );
  if (runResult) {
    await emitDelegatedUsageRollupForLease({
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      parentRunLeaseId: input.parentRunLeaseId,
      parentRunLeaseOwner: input.parentRunLeaseOwner,
      childSessionId: input.childSessionId,
      parentToolCallId: input.parentToolCallId,
    });
    return {
      ...runResult,
      childSessionId: input.childSessionId,
      agentName: child.agentName,
      agentPath: child.agentPath,
    };
  }

  const assistant = await loadAssistantResponseForMessage(input.childSessionId, childMessageId);
  if (!assistant?.content.trim()) {
    await emitDelegatedUsageRollupForLease({
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      parentRunLeaseId: input.parentRunLeaseId,
      parentRunLeaseOwner: input.parentRunLeaseOwner,
      childSessionId: input.childSessionId,
      parentToolCallId: input.parentToolCallId,
    });
    return {
      ok: false,
      status: "failed",
      resumed: true,
      childSessionId: input.childSessionId,
      messageId: childMessageId,
      agentName: child.agentName,
      agentPath: child.agentPath,
      error: "Delegated agent completed without a final answer.",
    };
  }

  await emitDelegatedUsageRollupForLease({
    parentSessionId: input.parentSessionId,
    parentMessageId: input.parentMessageId,
    parentRunLeaseId: input.parentRunLeaseId,
    parentRunLeaseOwner: input.parentRunLeaseOwner,
    childSessionId: input.childSessionId,
    parentToolCallId: input.parentToolCallId,
  });

  return {
    ok: true,
    status: "completed",
    resumed: true,
    childSessionId: input.childSessionId,
    messageId: childMessageId,
    agentName: child.agentName,
    agentPath: child.agentPath,
    answer: assistant.content,
  };
}

function resolveDelegatedAgentReference(agent: string, references: AgentReference[]) {
  const normalized = normalizeDelegatedAgentKey(agent);
  return references.find((reference) => {
    const path = reference.path;
    const slug =
      path.startsWith("agents/") && path.endsWith(".agent")
        ? path.slice("agents/".length, -".agent".length)
        : "";
    const mention = path.startsWith("agents/") && path.endsWith(".agent") ? `agent/${slug}` : "";
    return (
      normalizeDelegatedAgentKey(path) === normalized ||
      normalizeDelegatedAgentKey(mention) === normalized ||
      normalizeDelegatedAgentKey(slug) === normalized ||
      normalizeDelegatedAgentKey(reference.name) === normalized
    );
  });
}

function normalizeDelegatedAgentKey(value: string) {
  return value
    .trim()
    .replace(/^@/, "")
    .replace(/\.agent$/i, "")
    .toLowerCase();
}

async function loadDelegatedAgent(workspaceId: string, path: string) {
  const [agent] = await getDb()
    .select({
      id: agents.id,
      name: agents.name,
      path: agents.path,
      config: agents.config,
    })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.path, path)))
    .limit(1);

  return agent ? { ...agent, config: normalizeAgentConfig(agent.config) } : null;
}

async function loadDelegatedChildSession(input: {
  sessionId: string;
  workspaceId: string;
  userId: string;
}) {
  const [session] = await getDb()
    .select({
      id: agentSessions.id,
      workspaceId: agentSessions.workspaceId,
      userId: agentSessions.userId,
      agentId: agentSessions.agentId,
      agentName: agents.name,
      agentPath: agents.path,
      status: agentSessions.status,
      source: agentSessions.source,
      parentSessionId: agentSessions.parentSessionId,
      runLeaseId: agentSessions.runLeaseId,
      archivedAt: agentSessions.archivedAt,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(
      and(
        eq(agentSessions.id, input.sessionId),
        eq(agentSessions.workspaceId, input.workspaceId),
        eq(agentSessions.userId, input.userId),
        eq(agentSessions.source, "agent"),
      ),
    )
    .limit(1);

  return session ?? null;
}

function isDelegatedChildSessionBusy(
  session: NonNullable<Awaited<ReturnType<typeof loadDelegatedChildSession>>>,
) {
  return (
    Boolean(session.runLeaseId) ||
    ["provisioning", "running", "aborting", "archiving"].includes(session.status)
  );
}

async function appendDelegatedChildUserMessage(input: { sessionId: string; prompt: string }) {
  const now = new Date();
  const messageId = newAgentSessionMessageId();

  await getDb().transaction(async (tx) => {
    await tx.insert(agentSessionMessages).values({
      id: messageId,
      sessionId: input.sessionId,
      role: "user",
      status: "completed",
      content: input.prompt,
      modelMessage: { role: "user", content: input.prompt },
      completedAt: now,
    });
    await tx.insert(agentSessionEvents).values({
      sessionId: input.sessionId,
      messageId,
      type: "message.created",
      payload: {
        messageId,
        role: "user",
        content: input.prompt,
        status: "completed",
      },
    });
  });

  return messageId;
}

async function createDelegatedAgentSession(input: {
  sessionId: string;
  messageId: string;
  workspaceId: string;
  userId: string;
  agentId: string;
  agentName: string;
  modelProvider: string;
  modelName: string;
  prompt: string;
  parentSessionId: string;
  parentMessageId: string;
  toolCallId: string;
}) {
  const now = new Date();
  await getDb().transaction(async (tx) => {
    await tx.insert(agentSessions).values({
      id: input.sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agentId,
      title: delegationSessionTitle(input.agentName, input.prompt),
      source: "agent",
      modelProvider: input.modelProvider,
      modelName: input.modelName,
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      parentToolCallId: input.toolCallId,
    });
    await tx.insert(agentSessionMessages).values({
      id: input.messageId,
      sessionId: input.sessionId,
      role: "user",
      status: "completed",
      content: input.prompt,
      modelMessage: { role: "user", content: input.prompt },
      completedAt: now,
    });
    await tx.insert(agentSessionEvents).values({
      sessionId: input.sessionId,
      type: "session.status",
      payload: {
        status: "created",
        message: "Delegated agent session created",
        parentSessionId: input.parentSessionId,
        parentMessageId: input.parentMessageId,
        toolCallId: input.toolCallId,
      },
    });
    await tx.insert(agentSessionEvents).values({
      sessionId: input.sessionId,
      messageId: input.messageId,
      type: "message.created",
      payload: {
        messageId: input.messageId,
        role: "user",
        content: input.prompt,
        status: "completed",
      },
    });
  });
}

function delegationSessionTitle(agentName: string, prompt: string) {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const suffix = firstLine ? `: ${firstLine}` : "";
  const title = `${agentName}${suffix}`;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}
