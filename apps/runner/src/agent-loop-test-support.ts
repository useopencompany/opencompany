import type {
  AgentConfig,
  AgentSessionQuestionAnswer,
  AgentSessionQuestionPrompt,
} from "@opencompany/agent-runtime";
import {
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agentSessionToolUsage,
  agentSessionUsage,
  agents,
} from "@opencompany/db/schema";
import { vi } from "vitest";
import type { RunnerEnv } from "./env";
import type { LeaseWriteStore } from "./lease-writes";

export type MessageState = {
  id: string;
  sessionId: string;
  role?: string;
  content?: string;
  status?: string;
  responseToMessageId?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
};

export type UsageState = {
  id: number;
  stepIndex: number;
};

export type ToolUsageState = {
  id: number;
  toolCallId: string;
  toolName: string;
  provider: string;
  operation: string;
  providerRequestId?: string | null;
  costUsdMicros: number;
};

export type ToolApprovalState = {
  id: number;
  sessionId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  providerKey: string;
  permissionGroup: "read" | "post" | "modify" | "admin";
  status: "pending" | "approved" | "denied";
  inputPreview: string | null;
};

export type SessionQuestionState = {
  id: number;
  sessionId: string;
  messageId: string;
  toolCallId: string;
  questions: AgentSessionQuestionPrompt[];
  answers: AgentSessionQuestionAnswer[] | null;
  status: "pending" | "answered" | "cancelled";
};

export type DelegationSessionState = {
  id: string;
  workspaceId: string;
  userId: string;
  agentId: string;
  status: string;
  source?: string;
  parentSessionId?: string | null;
  parentMessageId?: string | null;
  parentToolCallId?: string | null;
  runLeaseId?: string | null;
  archivedAt?: Date | null;
};

export type LeaseDbState = {
  session: {
    id: string;
    archivedAt: Date | null;
    runLeaseId: string | null;
    runLeaseOwner: string | null;
  };
  messages: MessageState[];
  usage: UsageState[];
  toolUsage: ToolUsageState[];
  approvals: ToolApprovalState[];
  questions?: SessionQuestionState[];
};

// In-memory `LeaseWriteStore` that mirrors the atomic SQL semantics against the fake
// db's `state`: a write lands only while the lease still matches the session row, and
// it distinguishes "lease lost" from the idempotent "assistant already exists" path —
// exactly what the database statements enforce.
export function createStateLeaseWriteStore(getState: () => LeaseDbState): LeaseWriteStore {
  const leaseCurrent = (lease: { leaseId: string; leaseOwner: string }) => {
    const { session } = getState();
    return Boolean(
      session &&
        !session.archivedAt &&
        session.runLeaseId === lease.leaseId &&
        session.runLeaseOwner === lease.leaseOwner,
    );
  };

  return {
    async insertAssistantMessage(input, lease) {
      if (!leaseCurrent(lease)) return null;
      const { messages } = getState();
      if (
        input.responseToMessageId &&
        messages.some((message) => message.responseToMessageId === input.responseToMessageId)
      ) {
        return "conflict";
      }
      messages.push({
        id: input.id,
        sessionId: input.sessionId,
        role: "assistant",
        status: "running",
        responseToMessageId: input.responseToMessageId,
      });
      return "inserted";
    },
    async findResponseMessage(sessionId, responseToMessageId) {
      const message = getState().messages.find(
        (item) => item.sessionId === sessionId && item.responseToMessageId === responseToMessageId,
      );
      return message ? { id: message.id, status: message.status ?? "running" } : null;
    },
    async completeAssistantMessage(input, lease) {
      if (!leaseCurrent(lease)) return false;
      const message = getState().messages.find(
        (item) => item.id === input.assistantMessageId && item.sessionId === input.sessionId,
      );
      if (!message) return false;
      Object.assign(message, { status: "completed", content: input.content });
      return true;
    },
    async insertToolMessage(input, lease) {
      if (!leaseCurrent(lease)) return false;
      getState().messages.push({
        id: input.id,
        sessionId: input.sessionId,
        role: "tool",
        status: "completed",
        content: input.content,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
      });
      return true;
    },
    async insertToolApproval(input, lease) {
      if (!leaseCurrent(lease)) return null;
      const { approvals } = getState();
      if (
        approvals.some(
          (approval) =>
            approval.sessionId === input.sessionId && approval.toolCallId === input.toolCallId,
        )
      ) {
        return "conflict";
      }
      approvals.push({
        id: approvals.length + 1,
        ...input,
        status: "pending",
      });
      return "inserted" as const;
    },
    async insertSessionQuestion(input, lease) {
      if (!leaseCurrent(lease)) return null;
      // Bind to the actual state reference (seeding it when absent) so the push persists and the
      // duplicate check below can see prior inserts — `?? []` would mutate a throwaway array.
      const state = getState();
      state.questions ??= [];
      const questions = state.questions;
      if (
        questions.some(
          (question) =>
            question.sessionId === input.sessionId && question.toolCallId === input.toolCallId,
        )
      ) {
        return "conflict";
      }
      questions.push({
        id: questions.length + 1,
        sessionId: input.sessionId,
        messageId: input.messageId,
        toolCallId: input.toolCallId,
        questions: input.questions,
        answers: null,
        status: "pending",
      });
      return "inserted" as const;
    },
    async insertModelUsage(input, lease) {
      if (!leaseCurrent(lease)) return null;
      const { usage } = getState();
      const row = { id: usage.length + 1, ...input } as UsageState;
      usage.push(row);
      return { id: row.id };
    },
    async insertToolUsage(input, lease) {
      if (!leaseCurrent(lease)) return null;
      const { toolUsage } = getState();
      const row = { id: toolUsage.length + 1, ...input } as ToolUsageState;
      toolUsage.push(row);
      return { id: row.id };
    },
  };
}

export function createLeaseDb(input: {
  runLeaseId?: string | null;
  runLeaseExpiresAt?: Date | null;
  messages?: MessageState[];
  githubRows?: unknown[];
}) {
  const state = {
    session: {
      id: "ses_123",
      archivedAt: null as Date | null,
      runLeaseId: input.runLeaseId ?? null,
      runLeaseOwner: input.runLeaseId ? "runner-test" : null,
      runLeaseMessageId: null as string | null,
      runLeaseExpiresAt: input.runLeaseExpiresAt ?? null,
    },
    messages: [...(input.messages ?? [])],
    usage: [] as UsageState[],
    toolUsage: [] as ToolUsageState[],
    approvals: [] as ToolApprovalState[],
    questions: [] as SessionQuestionState[],
    ledgerDebits: 0,
  };

  return {
    state,
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return {
                async returning() {
                  if (table === agentSessions) {
                    if (typeof values.runLeaseId === "string") {
                      const expiresAt = state.session.runLeaseExpiresAt;
                      const canAcquire =
                        !state.session.archivedAt &&
                        (!state.session.runLeaseId || (expiresAt && expiresAt <= new Date()));
                      if (!canAcquire) return [];
                      Object.assign(state.session, values);
                      return [{ id: state.session.id, leaseId: state.session.runLeaseId }];
                    }

                    Object.assign(state.session, values);
                    return [{ id: state.session.id }];
                  }

                  if (table === agentSessionMessages) {
                    const message = state.messages.find(
                      (item) => item.id === values.id || item.id === "msg_assistant",
                    );
                    if (!message) return [];
                    Object.assign(message, values);
                    return [{ id: message.id }];
                  }

                  return [];
                },
              };
            },
          };
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          const query = {
            innerJoin() {
              return query;
            },
            where() {
              return query;
            },
            async limit() {
              if (table === agentSessions && state.session.runLeaseId === "run_123") {
                return [{ id: state.session.id }];
              }
              if (table === agentSessions && state.session.runLeaseId === "run_current") {
                return [];
              }
              if (table === agentSessions) return [{ id: state.session.id }];
              if (table === agentSessionMessages) {
                return state.messages
                  .filter((message) => message.responseToMessageId)
                  .map((message) => ({
                    id: message.id,
                    status: message.status ?? "running",
                  }))
                  .slice(0, 1);
              }
              return input.githubRows ?? [];
            },
          };
          return query;
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === agentSessionUsage) {
            const row = { id: state.usage.length + 1, ...values } as UsageState;
            state.usage.push(row);
            return {
              async returning() {
                return [{ id: row.id }];
              },
            };
          }
          if (table === agentSessionToolUsage) {
            const row = { id: state.toolUsage.length + 1, ...values } as ToolUsageState;
            state.toolUsage.push(row);
            return {
              async returning() {
                return [{ id: row.id }];
              },
            };
          }

          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  if (table !== agentSessionMessages) return [];
                  if (
                    state.messages.some(
                      (message) => message.responseToMessageId === values.responseToMessageId,
                    )
                  ) {
                    return [];
                  }
                  state.messages.push(values as MessageState);
                  return [{ id: values.id }];
                },
              };
            },
            async returning() {
              state.messages.push(values as MessageState);
              return [{ id: values.id }];
            },
          };
        },
      };
    },
    async execute() {
      state.ledgerDebits += 1;
      return { rows: [{ ledgerId: state.ledgerDebits, balanceUsdMicros: 100_000 }] };
    },
  };
}

export function createDelegationDb(
  input: { sessions?: DelegationSessionState[]; rollupRow?: Record<string, unknown> } = {},
) {
  const state = {
    agent: {
      id: "agt_research",
      name: "Research",
      path: "agents/research/research.agent",
      config: {
        ...agentConfig(),
        title: "Research",
        agents: [],
      },
    },
    sessions: [...(input.sessions ?? [])],
    messages: [] as MessageState[],
    events: [] as Array<{ sessionId?: string; type?: string; payload?: unknown }>,
    rollupRow: input.rollupRow ?? defaultDelegationRollupRow(),
  };
  let executeCount = 0;

  const db = {
    state,
    select() {
      const query = {
        table: undefined as unknown,
        from(table: unknown) {
          query.table = table;
          return query;
        },
        innerJoin() {
          return query;
        },
        where() {
          return query;
        },
        async limit() {
          if (query.table === agents) {
            return [state.agent];
          }
          if (query.table === agentSessions) {
            const session =
              state.sessions.find((item) => item.runLeaseId === "run_parent") ??
              state.sessions.at(0);
            if (!session) return [];
            return [
              {
                ...session,
                agentName: state.agent.name,
                agentPath: state.agent.path,
                source: session.source ?? "agent",
              },
            ];
          }
          if (query.table === agentSessionMessages) {
            const assistant = [...state.messages]
              .reverse()
              .find((message) => message.role === "assistant" && message.responseToMessageId);
            return assistant
              ? [
                  {
                    id: assistant.id,
                    status: assistant.status ?? "completed",
                    content: assistant.content ?? "",
                  },
                ]
              : [];
          }
          return [];
        },
      };
      return query;
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === agentSessions) {
            state.sessions.push({
              id: values.id as string,
              workspaceId: values.workspaceId as string,
              userId: values.userId as string,
              agentId: values.agentId as string,
              status: (values.status as string | undefined) ?? "created",
              source: (values.source as string | undefined) ?? "user",
              parentSessionId: (values.parentSessionId as string | null | undefined) ?? null,
              parentMessageId: (values.parentMessageId as string | null | undefined) ?? null,
              parentToolCallId: (values.parentToolCallId as string | null | undefined) ?? null,
              runLeaseId: null,
              archivedAt: null,
            });
          }
          if (table === agentSessionMessages) {
            state.messages.push(values as MessageState);
          }
          if (table === agentSessionEvents) {
            state.events.push(values);
          }
          return {};
        },
      };
    },
    async transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback(db);
    },
    async execute() {
      executeCount += 1;
      if (executeCount % 2 === 0) {
        return {
          rows: state.events
            .filter(
              (event) =>
                event.sessionId === "ses_parent" && event.type === "session.delegated_usage",
            )
            .map((event) => ({ payload: event.payload })),
        };
      }
      return {
        rows: [state.rollupRow],
      };
    },
  };

  return db;
}

export function defaultDelegationRollupRow() {
  return {
    inputTokens: 0,
    inputNoCacheTokens: 0,
    inputCacheReadTokens: 0,
    inputCacheWriteTokens: 0,
    outputTokens: 0,
    outputTextTokens: 0,
    outputReasoningTokens: 0,
    totalTokens: 0,
    providerCostUsdMicros: 0,
    platformFeeUsdMicros: 0,
    totalCostUsdMicros: 0,
    modelCostUsdMicros: 0,
    toolCostUsdMicros: 0,
    toolUsageTotalCostUsdMicros: 0,
    toolUsageByProviderOperation: [],
  };
}

export function createGitHubWorkRepositoryDb(rows: unknown[]) {
  const query = {
    from: vi.fn(() => query),
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  };
  const updateSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
  return {
    select: vi.fn(() => query),
    update: vi.fn(() => ({ set: updateSet })),
    updateSet,
  };
}

export function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "vag",
    integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
    exaApiKey: "exa_test",
    xApiBearerToken: "x_test",
    supadataApiKey: "supadata_test",
    ampApiKey: "amp_test",
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner-test",
    ...overrides,
  };
}

export function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = baseAgentConfig();
  return {
    ...base,
    ...overrides,
  };
}

export function baseAgentConfig(): AgentConfig {
  return {
    schemaVersion: "agent.v1" as const,
    title: "Test agent",
    instructions: "Test.",
    model: {
      provider: "vercel-ai-gateway" as const,
      name: "openai/gpt-5.4-mini" as const,
    },
    tools: [],
    brain: [],
    integrations: { github: { repositories: [] } },
    triggers: [],
  };
}

export function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: undefined,
    },
    totalTokens: inputTokens + outputTokens,
  };
}
