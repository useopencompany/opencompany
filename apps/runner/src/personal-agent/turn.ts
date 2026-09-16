import {
  CHAT_MAX_STEPS,
  createProductChatToolContext,
  prepareProductChatStep,
} from "@opencompany/agent/chat-agent";
import type {
  WebFetchToolInput,
  WebFetchToolOutput,
  WebSearchToolInput,
  WebSearchToolOutput,
} from "@opencompany/agent/chat-ui";
import {
  listedActionSourceIdsFromMessages,
  listedSkillIdsFromMessages,
  toChatUiMessage,
} from "@opencompany/agent/chat-ui";
import { executeChatExaFetch } from "@opencompany/agent/chat-web-fetch";
import { executeChatExaSearch } from "@opencompany/agent/chat-web-search";
import { imessageConfig, imessageSystemBlock } from "@opencompany/agent/integrations/imessage";
import { guardKimiOutput } from "@opencompany/agent/kimi-output-guard";
import { resolveProductLanguageModel } from "@opencompany/agent/language-model";
import { createProductChatSystemPrompt } from "@opencompany/agent/prompts";
import { AGENT_MODEL_CATALOG, resolveAvailableAgentModelId } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getImessageBindingForConversation } from "@opencompany/db/imessage";
import type { CodexChatSession, CodexChatTurn } from "@opencompany/db/product-schema";
import { getWorkspaceRole } from "@opencompany/db/workspaces";
import { createLogger } from "@opencompany/observability";
import { getBraintrustAISDK } from "@opencompany/observability/braintrust";
import { createGatewayAttribution } from "@opencompany/telemetry";
import { flushLatitude } from "@opencompany/telemetry/latitude";
import * as ai from "ai";
import { stepCountIs, type ToolSet } from "ai";
import {
  CodexChatHandoffError,
  CodexChatLeaseLostError,
  CodexChatRetryableInfrastructureError,
} from "../codex-chat-errors";
import type { CodingEngineTurnInput } from "../coding-engine-registry";
import { getDb } from "../db";
import type { RunnerEnv } from "../env";
import { createActionDispatcher } from "../opencompany-action-gateway";
import {
  consumeProductChatStream,
  createProductAbortWatcher,
  createSteeringTraceChannel,
  errorMessage,
  finalizeStreamingParts,
  hasHostedTurnCredits,
  isReplaySafeProductChatInfrastructureFailure,
  loadProductChatContextCompaction,
  loadProductChatStoredMessages,
  persistProductChatContextCompaction,
  productChatGatewayProviderOptions,
  productChatInfrastructureFailureDiagnostic,
  productModelMessagesFromReplay,
  projectionText,
  recognizedAbortError,
  withCompletedResponseFallback,
} from "../opencompany-chat";
import {
  createProductChatProjector,
  ProductChatInterruptedError,
  type ProductChatProjection,
} from "../opencompany-chat-projector";
import {
  CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS,
  CONTEXT_COMPACTION_SYSTEM_PROMPT,
  compactProductChatContextIfNeeded,
} from "../opencompany-context-compaction";
import { loadHostTools } from "../opencompany-host-tools";
import { createSubagentTraceChannel } from "../opencompany-subagent";
import {
  createImessageDelivery,
  type ImessageDelivery,
  readImessageInboundSettings,
  withoutActionApprovals,
} from "./imessage-delivery";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-personal-agent" });

const OUT_OF_CREDITS_MESSAGE =
  "This workspace is out of credits. Hobby usage refreshes on the first of the month; Pro admins can add credits in Settings → Billing.";
const FAILURE_TEXT = "Something went wrong on my end. Give me a minute and text me again.";

// The web view of the iMessage Conversation. A member typing here gets an ordinary in-chat answer
// with the same narrowed tool set; nothing is sent to the phone from a web-originated turn.
const WEB_VIEW_BLOCK = [
  '<channel name="imessage_web_view">',
  "This is the web view of the user's iMessage assistant. Earlier assistant turns answered by text message through the imessage_send tool; this turn was typed in the opencompany app, so answer here in plain prose. Nothing from this turn is sent to the phone.",
  "</channel>",
].join("\n");

// The iMessage personal assistant: an opencompany-engine runtime with `harness = 'personal_agent'`.
// It shares the durable session, run and message tables, the projector, the action and host-tool
// gateways and context compaction with the main chat harness, and owns its prompt, tool set,
// approval policy and delivery. Nothing here runs for a `chat` harness session.
export async function runPersonalAgentTurn(
  input: CodingEngineTurnInput,
): Promise<"settled" | "handed_off"> {
  const { turn, env } = input;
  const requestedModel = input.session.model as AgentModelId;
  const availableModel = resolveAvailableAgentModelId(requestedModel);
  const session =
    availableModel === requestedModel ? input.session : { ...input.session, model: availableModel };
  const leaseId = turn.leaseId;
  const leaseOwner = turn.leaseOwner;
  if (!leaseId || !leaseOwner) {
    throw new Error(`Claimed personal agent turn ${turn.id} is missing its lease.`);
  }
  if (session.engine !== "opencompany" || session.harness !== "personal_agent") {
    throw new Error(`Session ${session.id} is not a personal agent session.`);
  }
  if (!session.workspaceId) {
    throw new Error("Personal agent session is missing its workspace.");
  }
  const workspaceId = session.workspaceId;
  const modelResolution = await resolveProductLanguageModel({
    workspaceId,
    modelId: session.model,
    feature: "chat",
    gatewayApiKey: env.vercelAiGatewayApiKey,
    db: getDb(),
  });
  const subscriptionCovered = modelResolution.billing === "subscription_covered";
  const projector = createProductChatProjector({
    target: {
      userWorkosId: turn.userWorkosId,
      codexChatSessionId: session.id,
      chatSessionId: session.chatSessionId,
      turnId: turn.id,
      taskId: null,
      userMessageId: turn.userMessageId,
      assistantMessageId: turn.assistantMessageId,
      workspaceId,
      model: session.model,
      billing: subscriptionCovered ? "subscription_covered" : "metered_gateway",
      provider: subscriptionCovered ? "codex-backend" : "gateway",
      leaseId,
      leaseOwner,
      ...(input.canonicalAttemptId ? { canonicalAttemptId: input.canonicalAttemptId } : {}),
      turnStartedAt:
        turn.runAfter && turn.runAfter > turn.createdAt ? turn.runAfter : turn.createdAt,
    },
  });
  let projection: ProductChatProjection = { parts: [] };
  await projector.started();
  if (turn.interruptRequestedAt) {
    await projector.interrupted(projection, null);
    return "settled";
  }

  const generationController = new AbortController();
  const delivery = await resolveDelivery({
    session,
    turn,
    env,
    signal: generationController.signal,
  });

  if (!subscriptionCovered && !(await hasHostedTurnCredits(workspaceId))) {
    projection = { parts: [{ type: "text", text: OUT_OF_CREDITS_MESSAGE }] };
    await delivery?.sendFallback(OUT_OF_CREDITS_MESSAGE);
    await projector.failed(OUT_OF_CREDITS_MESSAGE, projection, null);
    return "settled";
  }

  const abortWatcher = createProductAbortWatcher({
    signalController: generationController,
    projector,
    ...(input.shouldAbort ? { shouldAbort: input.shouldAbort } : {}),
  });
  let runtimeCleanup: (() => Promise<void>) | null = null;
  try {
    await abortWatcher.checkNow();
    delivery?.startTyping();
    const storedMessages = await loadProductChatStoredMessages({
      chatSessionId: session.chatSessionId,
      currentUserMessageId: turn.userMessageId,
      includeCurrentAssistantMessage: false,
    });
    const storedUiMessages = storedMessages.map((message) => toChatUiMessage(message));
    const runtime = await resolvePersonalAgentRuntime({
      turn,
      session,
      env,
      workspaceId,
      signal: generationController.signal,
      prelistedActionSourceIds: listedActionSourceIdsFromMessages(storedUiMessages),
      prelistedSkillIds: listedSkillIdsFromMessages(storedUiMessages),
      delivery,
    });
    runtimeCleanup = runtime.cleanup;
    const { generateText, streamText } = getBraintrustAISDK(ai);
    const providerOptions =
      modelResolution.providerOptions ??
      productChatGatewayProviderOptions(
        createGatewayAttribution({
          userWorkosId: turn.userWorkosId,
          feature: "chat",
          chatSessionId: session.chatSessionId,
        }),
      );
    const context = await compactProductChatContextIfNeeded({
      storedMessages,
      currentUserMessageId: turn.userMessageId,
      modelId: runtime.model,
      system: runtime.system,
      tools: runtime.tools,
      previousState: await loadProductChatContextCompaction(session.chatSessionId),
      toModelMessages: (messages) =>
        productModelMessagesFromReplay(messages, turn.userMessageId, {
          modelId: runtime.model,
          blobToken: env.blobReadWriteToken,
          activeSkills: runtime.activeSkills,
        }),
      summarize: async (prompt) => {
        const result = await generateText({
          model: modelResolution.model,
          system: `${runtime.system}\n\n${CONTEXT_COMPACTION_SYSTEM_PROMPT}`,
          prompt,
          maxOutputTokens: CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS,
          abortSignal: generationController.signal,
          providerOptions,
        });
        return { text: result.text, usage: result.usage };
      },
      persist: (state) =>
        persistProductChatContextCompaction({
          state,
          chatSessionId: session.chatSessionId,
          codexChatSessionId: session.id,
          turnId: turn.id,
          leaseId,
          leaseOwner,
        }),
    });
    if (context.compacted && context.usage) {
      await projector.recordStepUsage({ stepIndex: -1, usage: context.usage });
    }
    const stream = streamText({
      model: guardKimiOutput(modelResolution.model, runtime.model),
      system: runtime.system,
      messages: context.messages,
      tools: runtime.tools,
      stopWhen: stepCountIs(runtime.maxSteps),
      prepareStep: async ({ stepNumber }) =>
        prepareProductChatStep({
          stepNumber,
          maxSteps: runtime.maxSteps,
          system: runtime.system,
          wikiContext: runtime.toolContext.getSelectedWikiContext(),
          actionCallsExhausted: runtime.toolContext.areActionCallsExhausted(),
          toolNames: Object.keys(runtime.tools),
        }),
      ...(runtime.toolContext.repairToolCall
        ? { experimental_repairToolCall: runtime.toolContext.repairToolCall }
        : {}),
      abortSignal: generationController.signal,
      providerOptions,
    });
    projection = await consumeProductChatStream({
      fullStream: stream.fullStream,
      signal: generationController.signal,
      steeringTrace: createSteeringTraceChannel(),
      subagentTrace: createSubagentTraceChannel(),
      sink: {
        project: async (nextProjection) => {
          projection = nextProjection;
          await projector.project(nextProjection);
        },
        recordStepUsage: (usage) => projector.recordStepUsage(usage),
      },
      initialProjection: projection,
    });
    await abortWatcher.checkNow();
    projection = withCompletedResponseFallback(projection);
    // The tool is the delivery path; prose the model wrote instead of calling it would otherwise
    // land only in the web view while the phone stays silent.
    if (delivery && !delivery.delivered()) {
      await delivery.sendFallback(projectionText(projection));
    }
    await abortWatcher.stop();
    await projector.completed(projection, null);
    return "settled";
  } catch (error) {
    const effectiveError = recognizedAbortError(error)
      ? error
      : recognizedAbortError(generationController.signal.reason)
        ? generationController.signal.reason
        : (input.shouldAbort?.() ?? error);
    projection = { ...projection, parts: finalizeStreamingParts(projection.parts) };
    if (effectiveError instanceof CodexChatHandoffError) return "handed_off";
    if (effectiveError instanceof ProductChatInterruptedError) {
      await projector.interrupted(projection, null);
      return "settled";
    }
    if (effectiveError instanceof CodexChatLeaseLostError) throw effectiveError;
    if (isReplaySafeProductChatInfrastructureFailure(effectiveError, projection)) {
      throw new CodexChatRetryableInfrastructureError(
        "The model response stream ended before it could be completed.",
        effectiveError,
        productChatInfrastructureFailureDiagnostic(effectiveError),
      );
    }
    const message = errorMessage(effectiveError);
    logger.warn("Personal agent turn failed", {
      event: "opencompany.personal_agent_turn_failed",
      turn_id: turn.id,
      codex_chat_session_id: session.id,
      attempt: turn.attempts,
      error_name: effectiveError instanceof Error ? effectiveError.name : typeof effectiveError,
      error: message,
    });
    if (delivery && !delivery.delivered()) await delivery.sendFallback(FAILURE_TEXT);
    await projector.failed(message, projection, null);
    return "settled";
  } finally {
    await abortWatcher.stop();
    await runtimeCleanup?.().catch((error) => {
      logger.warn("Personal agent host cleanup failed", {
        event: "opencompany.personal_agent_host_cleanup_failed",
        turn_id: turn.id,
        error: errorMessage(error),
      });
    });
    await flushLatitude();
  }
}

// A Run started by a text carries the webhook stamp and the member's binding must still exist;
// then, and only then, the turn can send. A web-originated Run gets no delivery.
async function resolveDelivery(input: {
  session: CodexChatSession;
  turn: CodexChatTurn;
  env: RunnerEnv;
  signal: AbortSignal;
}): Promise<ImessageDelivery | null> {
  const inbound = readImessageInboundSettings(input.turn.settings as Record<string, unknown>);
  if (!inbound) return null;
  const config = imessageConfig({
    MESSAGES_API_KEY: input.env.messagesApiKey,
    MESSAGES_LINE_HANDLE: input.env.messagesLineHandle,
  });
  if (!config) {
    logger.error("iMessage turn without messages.dev configuration", {
      event: "opencompany.personal_agent_imessage_unconfigured",
      turn_id: input.turn.id,
    });
    return null;
  }
  const binding = await getImessageBindingForConversation({
    conversationId: input.session.chatSessionId,
    userWorkosId: input.turn.userWorkosId,
  });
  if (!binding?.handle || binding.handle !== inbound.sender) return null;
  return createImessageDelivery({
    config,
    handle: binding.handle,
    inbound,
    signal: input.signal,
  });
}

async function resolvePersonalAgentRuntime(input: {
  turn: CodexChatTurn;
  session: CodexChatSession;
  env: RunnerEnv;
  workspaceId: string;
  signal: AbortSignal;
  prelistedActionSourceIds: readonly string[];
  prelistedSkillIds: readonly string[];
  delivery: ImessageDelivery | null;
}) {
  const { turn, session, env, signal } = input;
  const model = session.model as AgentModelId;
  if (!AGENT_MODEL_CATALOG.some((candidate) => candidate.id === model)) {
    throw new Error(`Unsupported personal agent model: ${session.model}.`);
  }
  const workspaceRole = await getWorkspaceRole(
    { userWorkosId: turn.userWorkosId, workspaceId: input.workspaceId },
    { db: getDb() },
  );
  if (!workspaceRole) throw new Error("You no longer have access to this assistant's workspace.");

  const [actionDispatcher, hostTools] = await Promise.all([
    createActionDispatcher({
      ...(session.hostToolContractVersion
        ? { hostToolContractVersion: session.hostToolContractVersion }
        : {}),
      sessionId: session.id,
      turnId: turn.id,
      signal,
      approvalContinuation: false,
      prelistedSourceIds: input.prelistedActionSourceIds,
    }),
    loadHostTools({
      sessionId: session.id,
      turnId: turn.id,
      env,
      signal,
      mentionedSkillIds: [],
      approvalContinuation: false,
      prelistedSkillIds: input.prelistedSkillIds,
    }),
  ]);
  if (!actionDispatcher || !hostTools) {
    throw new Error("The durable Chat host gateways are not configured.");
  }
  const currentDate = new Date();
  const exaApiKey = env.exaApiKey?.trim();
  const webSearch = exaApiKey
    ? async (toolInput: WebSearchToolInput): Promise<WebSearchToolOutput> => {
        try {
          return await executeChatExaSearch({ toolInput, apiKey: exaApiKey, signal, currentDate });
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      }
    : null;
  const webFetch = exaApiKey
    ? async (toolInput: WebFetchToolInput): Promise<WebFetchToolOutput> => {
        try {
          return await executeChatExaFetch({ toolInput, apiKey: exaApiKey, signal });
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      }
    : null;
  const actions = withoutActionApprovals(actionDispatcher);
  // Web search, wiki, skills and plugin actions only. No schedules, workflows, browser,
  // artifacts, brain or subagents: a phone surface has nowhere to show or approve them.
  const toolContext = createProductChatToolContext({
    model,
    ...(hostTools.runWiki ? { runWiki: hostTools.runWiki as never } : {}),
    ...(hostTools.workspaceSkills ? { workspaceSkills: hostTools.workspaceSkills } : {}),
    ...(hostTools.skills ? { skills: hostTools.skills } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(webFetch ? { webFetch } : {}),
    actions,
  });
  const tools: ToolSet = { ...toolContext.tools, ...(input.delivery?.tools ?? {}) };
  const system = [
    createProductChatSystemPrompt({
      currentDate,
      webFetchEnabled: Boolean(webFetch),
      webSearchEnabled: Boolean(webSearch),
      browserToolsEnabled: false,
      automationToolsEnabled: false,
      scheduleToolsEnabled: false,
      artifactToolEnabled: false,
      subagentsEnabled: false,
      wikiToolEnabled: Boolean(hostTools.runWiki),
      activeBrain: null,
      userContext: hostTools.bootstrap.userContext,
      skillsAvailable: hostTools.bootstrap.skills.length > 0,
      ...(actionDispatcher.catalog.sources.length
        ? {
            actionSources: actionDispatcher.catalog.sources,
            legacyActionDiscovery: actionDispatcher.legacyDiscovery ?? false,
            connectedIntegrations: actionDispatcher.catalog.sources,
          }
        : {}),
    }),
    input.delivery
      ? imessageSystemBlock({
          inboundMessageId:
            readImessageInboundSettings(turn.settings as Record<string, unknown>)?.messageId ??
            null,
        })
      : WEB_VIEW_BLOCK,
  ].join("\n\n");
  return {
    model,
    activeSkills: hostTools.activeSkills,
    toolContext,
    tools,
    system,
    maxSteps: CHAT_MAX_STEPS,
    cleanup: hostTools.close ?? (async () => undefined),
  };
}
