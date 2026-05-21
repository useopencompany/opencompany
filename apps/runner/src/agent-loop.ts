import {
  CORE_TOOL_DEFINITIONS,
  newAgentSessionMessageId,
  newRunLeaseId,
  resolveAgentRuntimeConfig,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  agents,
  agentSessionMessages,
  agentSessions,
  workspaceRepositories,
  workspaces,
} from "@opencompany/db/schema";
import { createGateway, jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from "ai";
import { asc, eq } from "drizzle-orm";
import { appendRuntimeEvent } from "./events";
import type { RunnerEnv } from "./env";
import { getGitHubInstallationToken } from "./github";
import { createOrConnectSandbox, prepareWorkspace, runSandboxTool, type SandboxHandle } from "./sandbox";

const activeRuns = new Map<string, AbortController>();

export async function startSession(sessionId: string, env: RunnerEnv) {
  const db = getDb();
  const row = await loadSession(sessionId);
  await setStatus(sessionId, "provisioning");
  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "provisioning", message: "Starting sandbox" },
  });

  const sandbox = await ensureSandbox(row, env);
  await db
    .update(agentSessions)
    .set({
      e2bSandboxId: sandbox.sandboxId,
      status: "ready",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(agentSessions.id, sessionId));
  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "ready", message: "Sandbox ready" },
  });
}

export async function abortSession(sessionId: string) {
  const db = getDb();
  activeRuns.get(sessionId)?.abort();
  await db
    .update(agentSessions)
    .set({ status: "aborting", abortRequestedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentSessions.id, sessionId));
  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "aborting", message: "Abort requested" },
  });
}

export async function runMessage(input: { sessionId: string; messageId: string; env: RunnerEnv }) {
  const db = getDb();
  const controller = new AbortController();
  activeRuns.set(input.sessionId, controller);
  const leaseId = newRunLeaseId();
  const assistantMessageId = newAgentSessionMessageId();

  try {
    const row = await loadSession(input.sessionId);
    const sandbox = await ensureSandbox(row, input.env);
    const runtime = resolveAgentRuntimeConfig({
      agent: row.agent.config,
      workspaceName: row.workspace.name,
      sessionTitle: row.session.title,
    });
    const gateway = createGateway({ apiKey: input.env.vercelAiGatewayApiKey });

    await db
      .update(agentSessions)
      .set({
        status: "running",
        runLeaseId: leaseId,
        e2bSandboxId: sandbox.sandboxId,
        modelProvider: runtime.model.provider,
        modelName: runtime.model.name,
        abortRequestedAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(agentSessions.id, input.sessionId));
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      type: "session.status",
      payload: { status: "running", message: "Agent is running" },
    });

    await db.insert(agentSessionMessages).values({
      id: assistantMessageId,
      sessionId: input.sessionId,
      role: "assistant",
      status: "running",
    });
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      messageId: assistantMessageId,
      type: "message.created",
      payload: { messageId: assistantMessageId, role: "assistant" },
    });

    const storedMessages = await db
      .select()
      .from(agentSessionMessages)
      .where(eq(agentSessionMessages.sessionId, input.sessionId))
      .orderBy(asc(agentSessionMessages.createdAt));
    const messages: ModelMessage[] = storedMessages
      .filter((message) => message.id !== assistantMessageId)
      .map((message): ModelMessage | null => {
        if (message.role === "user" || message.role === "assistant") {
          return { role: message.role, content: message.content };
        }
        return null;
      })
      .filter((message): message is ModelMessage => Boolean(message));
    const tools = createToolSet({
      sessionId: input.sessionId,
      assistantMessageId,
      sandbox,
      workdir: row.session.workdir,
      signal: controller.signal,
    });

    let assistantContent = "";
    const result = streamText({
      model: gateway(runtime.model.name),
      system: runtime.systemPrompt,
      messages,
      tools: pickRuntimeTools(tools, runtime.tools),
      stopWhen: stepCountIs(8),
      abortSignal: controller.signal,
    });

    for await (const part of result.fullStream) {
      throwIfAborted(controller.signal);

      if (part.type === "text-delta") {
        assistantContent += part.text;
        await appendRuntimeEvent(db, {
          sessionId: input.sessionId,
          messageId: assistantMessageId,
          type: "message.delta",
          payload: { messageId: assistantMessageId, delta: part.text },
        });
      }
    }

    await db
      .update(agentSessionMessages)
      .set({ status: "completed", content: assistantContent, completedAt: new Date() })
      .where(eq(agentSessionMessages.id, assistantMessageId));
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      messageId: assistantMessageId,
      type: "message.completed",
      payload: { messageId: assistantMessageId, content: assistantContent },
    });
    await setStatus(input.sessionId, "completed");
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      type: "session.status",
      payload: { status: "completed", message: "Agent completed" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown runner error";
    await db
      .update(agentSessions)
      .set({ status: controller.signal.aborted ? "aborting" : "failed", lastError: message, updatedAt: new Date() })
      .where(eq(agentSessions.id, input.sessionId));
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      type: "session.error",
      payload: { message },
    });
    throw error;
  } finally {
    activeRuns.delete(input.sessionId);
  }
}

function createToolSet(input: {
  sessionId: string;
  assistantMessageId: string;
  sandbox: SandboxHandle;
  workdir: string;
  signal: AbortSignal;
}) {
  const tools: ToolSet = {};

  for (const definition of CORE_TOOL_DEFINITIONS) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.parameters as Parameters<typeof jsonSchema>[0]),
      onInputDelta: async ({ inputTextDelta, toolCallId }) => {
        await appendRuntimeEvent(getDb(), {
          sessionId: input.sessionId,
          messageId: input.assistantMessageId,
          type: "tool.delta",
          payload: {
            messageId: input.assistantMessageId,
            toolCallId,
            delta: inputTextDelta,
          },
        });
      },
      onInputAvailable: async ({ input: toolInput, toolCallId }) => {
        await appendRuntimeEvent(getDb(), {
          sessionId: input.sessionId,
          messageId: input.assistantMessageId,
          type: "tool.started",
          payload: {
            messageId: input.assistantMessageId,
            toolCallId,
            name: definition.name,
            input: toolInput,
          },
        });
      },
      execute: async (toolInput, options) =>
        executeRuntimeTool({
          sessionId: input.sessionId,
          assistantMessageId: input.assistantMessageId,
          toolCallId: options.toolCallId,
          name: definition.name,
          args: toolInput,
          sandbox: input.sandbox,
          workdir: input.workdir,
          signal: input.signal,
        }),
    });
  }

  return tools;
}

function pickRuntimeTools(tools: ToolSet, names: string[]) {
  const picked: ToolSet = {};
  for (const name of names) {
    if (tools[name]) picked[name] = tools[name];
  }
  return picked;
}

async function executeRuntimeTool(input: {
  sessionId: string;
  assistantMessageId: string;
  toolCallId: string;
  name: string;
  args: unknown;
  sandbox: SandboxHandle;
  workdir: string;
  signal: AbortSignal;
}) {
  const db = getDb();
  throwIfAborted(input.signal);

  const output = await runSandboxTool({
    sandbox: input.sandbox,
    workdir: input.workdir,
    name: input.name,
    args: input.args,
    onOutput: async (stream, delta) => {
      await appendRuntimeEvent(db, {
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        type: "command.output",
        payload: {
          command: input.name,
          stream,
          delta,
        },
      });
    },
  });

  const changedPath =
    isRecord(output) && Object.prototype.hasOwnProperty.call(output, "path")
      ? (output as { path: unknown }).path
      : null;
  if (input.name === "write_file" && typeof changedPath === "string") {
    await appendRuntimeEvent(db, {
      sessionId: input.sessionId,
      type: "file.changed",
      payload: { path: changedPath, operation: "write" },
    });
  }

  const toolMessageId = newAgentSessionMessageId();
  await db.insert(agentSessionMessages).values({
    id: toolMessageId,
    sessionId: input.sessionId,
    role: "tool",
    status: "completed",
    content: JSON.stringify(output),
    toolName: input.name,
    toolCallId: input.toolCallId,
    completedAt: new Date(),
  });
  await appendRuntimeEvent(db, {
    sessionId: input.sessionId,
    messageId: input.assistantMessageId,
    type: "tool.completed",
    payload: {
      messageId: input.assistantMessageId,
      toolCallId: input.toolCallId,
      name: input.name,
      output,
    },
  });

  return output;
}

async function ensureSandbox(row: LoadedSession, env: RunnerEnv) {
  const sandbox = await createOrConnectSandbox({
    sandboxId: row.session.e2bSandboxId,
    template: env.e2bTemplate,
    envs: {
      E2B_API_KEY: env.e2bApiKey,
      VERCEL_AI_GATEWAY_API_KEY: env.vercelAiGatewayApiKey,
    },
  });
  await prepareWorkspace({
    sandbox,
    workdir: row.session.workdir,
    agentFile: row.agent.body,
    repositoryFullName: row.repository?.fullName,
    githubToken: await getGitHubInstallationToken(),
  });
  return sandbox;
}

async function loadSession(sessionId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      session: agentSessions,
      agent: agents,
      workspace: workspaces,
      repository: workspaceRepositories,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .innerJoin(workspaces, eq(agentSessions.workspaceId, workspaces.id))
    .leftJoin(workspaceRepositories, eq(agentSessions.workspaceId, workspaceRepositories.workspaceId))
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return row;
}

type LoadedSession = Awaited<ReturnType<typeof loadSession>>;

async function setStatus(sessionId: string, status: "provisioning" | "ready" | "completed") {
  await getDb()
    .update(agentSessions)
    .set({ status, updatedAt: new Date() })
    .where(eq(agentSessions.id, sessionId));
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Run aborted.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
