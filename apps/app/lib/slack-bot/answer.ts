import { captureGoatModelSpendRecorded } from "@opencompany/analytics/goat/server";
import { calculateModelUsageCost } from "@opencompany/billing";
import { projectActionCatalog } from "@opencompany/core/actions/policy";
import {
  ensureGoatMonthlyIncludedUsage,
  isGoatCreditsEnforcementEnabled,
} from "@opencompany/db/billing";
import { getDb } from "@opencompany/db/client";
import { hasPositiveGoatCreditBalance, recordGoatCreditDebit } from "@opencompany/db/credits";
import { loadGoatIntegrationCredential } from "@opencompany/db/integrations";
import { goatWorkspaces } from "@opencompany/db/schema";
import { goatSlackSelectedConversationIds } from "@opencompany/db/slack";
import {
  type GoatSlackBotIntegrationForTeam,
  getGoatSlackBotThreadParticipation,
  listEnabledGoatSlackBotBrainRoutes,
  listGoatSlackBotIntegrationsForTeam,
  pruneGoatSlackBotThreadParticipation,
  recordGoatSlackBotThreadParticipation,
} from "@opencompany/db/slack-bot";
import { DEFAULT_GOAT_BRAIN_SLUG, listAccessibleGoatBrains } from "@opencompany/db/workspaces";
import { recordGoatModelCost } from "@opencompany/telemetry";
import type { LanguageModelUsage } from "ai";
import { eq } from "drizzle-orm";
import { isGoatChatActionsKilled, resolveGoatActionCatalog } from "@/lib/actions/catalog";
import { executeGoatAction, type GoatActionResult } from "@/lib/actions/execute";
import type { GoatResolvedActionCatalog } from "@/lib/actions/types";
import { captureToGoatBrainInbox } from "@/lib/brain-capture";
import { runGoatBrainToolForUser } from "@/lib/brain-cli";
import {
  type GoatBrainMultiBrainTarget,
  normalizeGoatBrainReadToolInput,
} from "@/lib/brain-surface";
import { runOpenCompanyChatAgent } from "@/lib/chat-agent";
import { executeGoatChatExaSearch } from "@/lib/chat-web-search";
import { slackApiRequest } from "@/lib/integrations/slack";
import { goatSlackBotHasScope } from "@/lib/integrations/slack-bot";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { createGoatSlackSurfacePromptBlock } from "@/lib/prompts/slack-surface";
import {
  collectSlackMentionUserIds,
  mentionsSlackUser,
  sanitizeSlackMentions,
  stripSlackBotMention,
  toSlackMrkdwn,
  truncateForSlack,
} from "@/lib/slack-bot/format";
import {
  type GoatSlackSenderResolution,
  getGoatUserBasics,
  resolveGoatSlackSender,
} from "@/lib/slack-bot/identity";
import {
  createGoatSlackBotStatusReporter,
  type GoatSlackBotStatusReporter,
} from "@/lib/slack-bot/status";
import {
  fetchGoatSlackConversationContext,
  formatSpeaker,
  type SlackContextMessage,
} from "@/lib/slack-bot/thread-context";

export { stripSlackBotMention, toSlackMrkdwn, truncateForSlack } from "@/lib/slack-bot/format";

const SLACK_ANSWER_MAX_CHARS = 3000;
// Leave headroom under the webhook route's maxDuration (240s) for the Slack
// posting/cleanup that follows the agent turn.
const SLACK_AGENT_TIMEOUT_MS = 200_000;

export type GoatSlackBotEventInput = {
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs: string | null;
  text: string;
  slackUserId: string;
};

export type GoatSlackBotMentionInput = GoatSlackBotEventInput;

type SlackAnswerMode = "mention" | "follow_up" | "dm";

// Runs after the webhook has already acked Slack (via next/server after()):
// resolve the install → route to brains by channel → answer → post in-thread.
// Individual integration failures reply best-effort and are logged so another
// Goat workspace connected to the same Slack team can still answer.
export async function processGoatSlackBotMention(input: GoatSlackBotMentionInput) {
  // Mentioning the bot inside its DM raises app_mention too; that conversation
  // is personal, so route it through the DM rules (identity required).
  if (isDirectMessageChannel(input.channelId)) {
    return processGoatSlackBotDirectMessage(input, { viaMention: true });
  }
  const active = await connectedIntegrations(input.teamId);

  // Normally one install per team; two goat workspaces installing the same
  // Slack team both answer (accepted beta caveat, scoping keeps it unlikely).
  for (const integration of active) {
    await answerForIntegration(integration, input, "mention").catch((error) => {
      logAnswerFailure("mention", integration.id, input, error);
    });
  }
}

// A reply in a thread the bot already participates in answers without a fresh
// mention. The webhook has verified the participation row exists; here the
// reply is routed to the integration that recorded it.
export async function processGoatSlackBotThreadFollowUp(input: GoatSlackBotEventInput) {
  const threadTs = input.threadTs;
  if (!threadTs) return;
  const participation = await getGoatSlackBotThreadParticipation({
    teamId: input.teamId,
    channelId: input.channelId,
    threadTs,
  });
  if (!participation) return;

  const active = await connectedIntegrations(input.teamId);
  const integration = active.find((candidate) => candidate.id === participation.integrationId);
  if (!integration) return;
  await answerForIntegration(integration, input, "follow_up").catch((error) => {
    logAnswerFailure("follow_up", integration.id, input, error);
  });
}

export async function processGoatSlackBotDirectMessage(
  input: GoatSlackBotEventInput,
  options: { viaMention?: boolean } = {},
) {
  const active = await connectedIntegrations(input.teamId);
  if (active.length === 0) return;

  let refusalReply: (() => Promise<void>) | null = null;
  for (const integration of active) {
    const outcome = await answerForIntegration(integration, input, "dm", options).catch((error) => {
      logAnswerFailure("dm", integration.id, input, error);
      return "handled" as const;
    });
    if (outcome === "handled") return;
    if (outcome === "duplicate") return;
    if (!refusalReply && outcome.kind === "unmapped_dm") {
      const { botToken } = outcome;
      refusalReply = () =>
        postPlainSlackReply(
          botToken,
          input.channelId,
          input.threadTs,
          "I couldn't match your Slack account to an OpenCompany member in this workspace, so I can't answer here. Ask a workspace admin to invite you with this email, then message me again.",
        );
    }
  }
  // DMs are personal: never run a stranger's private question under the
  // installing admin's identity — refuse once instead.
  await refusalReply?.().catch(() => {});
}

type AnswerOutcome = "handled" | "duplicate" | { kind: "unmapped_dm"; botToken: string };

async function answerForIntegration(
  integration: GoatSlackBotIntegrationForTeam,
  input: GoatSlackBotEventInput,
  mode: SlackAnswerMode,
  options: { viaMention?: boolean } = {},
): Promise<AnswerOutcome> {
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: integration.userWorkosId,
    integrationId: integration.id,
    provider: "slack_bot",
    kind: "oauth_token",
  });
  const botToken =
    typeof credential?.payload.access_token === "string" ? credential.payload.access_token : null;
  const botUserId =
    typeof credential?.payload.bot_user_id === "string" ? credential.payload.bot_user_id : null;
  if (!botToken) {
    console.error("[goat-slack-bot] Missing bot credential", { integrationId: integration.id });
    return "handled";
  }

  // A DM that mentions the bot arrives both as message.im and app_mention; the
  // app_mention delivery owns it.
  if (mode === "dm" && !options.viaMention && mentionsSlackUser(input.text, botUserId)) {
    return "duplicate";
  }

  const replyThreadTs = mode === "dm" ? input.threadTs : (input.threadTs ?? input.messageTs);
  const reply = (text: string) =>
    postPlainSlackReply(botToken, input.channelId, replyThreadTs, text);

  const sender = await resolveGoatSlackSender({
    botToken,
    teamId: input.teamId,
    slackUserId: input.slackUserId,
    workspaceId: integration.workspaceId,
  });
  if (mode === "dm" && sender.kind !== "member") {
    return { kind: "unmapped_dm", botToken };
  }

  const brains = await resolveBrainTargets(integration, input.channelId, mode, sender);
  if (brains.kind === "none") {
    if (mode === "mention") {
      await reply(
        "This channel isn't connected to a brain yet. A workspace admin can enable it under Brain settings → Destinations.",
      );
    } else if (mode === "dm") {
      await reply("No brain is available in this workspace yet, so I can't answer here.");
    }
    // Follow-ups stay silent when routing was removed mid-thread.
    return "handled";
  }
  const identity =
    sender.kind === "member" && !brains.degradedToFallback
      ? { userWorkosId: sender.member.workosUserId, member: sender.member }
      : { userWorkosId: integration.userWorkosId, member: null };

  // Same rollout gate as the chat 402: debits always record, but the hard
  // stop only fires once enforcement is on.
  if (isGoatCreditsEnforcementEnabled()) {
    await ensureGoatMonthlyIncludedUsage(integration.workspaceId);
  }
  if (!(await hasPositiveGoatCreditBalance(integration.workspaceId))) {
    await reply("This workspace is out of credits, so I can't answer right now.");
    return "handled";
  }

  const question =
    mode === "mention" || options.viaMention
      ? stripSlackBotMention(input.text, botUserId)
      : input.text.trim();
  if (!question) {
    if (mode === "mention") {
      await reply(
        "Ask me something, e.g. `@opencompany what did we learn from customers this week?`",
      );
    }
    return "handled";
  }

  const status = createGoatSlackBotStatusReporter({
    botToken,
    channelId: input.channelId,
    triggerTs: input.messageTs,
    threadTs: replyThreadTs,
    canReact:
      integration.scopes.length === 0 ||
      goatSlackBotHasScope(integration.scopes, "reactions:write"),
  });

  try {
    // DMs pull recent conversation history even outside a thread; channel
    // mentions only carry context when they happen inside a thread.
    const contextMessages: SlackContextMessage[] =
      mode === "dm" || input.threadTs
        ? await fetchGoatSlackConversationContext({
            botToken,
            channelId: input.channelId,
            threadTs: input.threadTs,
            excludeTs: input.messageTs,
            botUserId,
          })
        : [];

    const answer = await runSlackChatAgent({
      integration,
      identity,
      brains: brains.targets,
      mode,
      status,
      question,
      contextMessages,
      slackUserId: input.slackUserId,
      sourceRef: `slack:${input.teamId}:${input.channelId}:${input.messageTs}`,
      // Latitude session: a DM conversation is one session; a channel groups
      // by thread so follow-ups land with the mention that started them.
      telemetrySessionId:
        mode === "dm"
          ? `slack:${input.teamId}:${input.channelId}`
          : `slack:${input.teamId}:${input.channelId}:${replyThreadTs ?? input.messageTs}`,
    });

    const allowedMentionUserIds = collectSlackMentionUserIds([
      input.text,
      ...contextMessages.map((message) => message.content),
    ]);
    allowedMentionUserIds.add(input.slackUserId);
    const { replyTs } = await status.finish(
      truncateForSlack(
        sanitizeSlackMentions(toSlackMrkdwn(answer.content), allowedMentionUserIds),
        SLACK_ANSWER_MAX_CHARS,
      ),
    );

    if (mode !== "dm") {
      const participationThreadTs = replyThreadTs ?? input.messageTs;
      await recordGoatSlackBotThreadParticipation({
        teamId: input.teamId,
        channelId: input.channelId,
        threadTs: participationThreadTs,
        integrationId: integration.id,
        botReplyTs: replyTs ?? input.messageTs,
      }).catch(() => {});
      await pruneGoatSlackBotThreadParticipation().catch(() => {});
    }

    await recordSlackBotUsage({
      workspaceId: integration.workspaceId,
      userWorkosId: identity.userWorkosId,
      model: DEFAULT_GOAT_MODEL,
      usage: answer.totalUsage,
      idempotencyKey: `slack_bot:${integration.id}:${input.teamId}:${input.channelId}:${input.messageTs}`,
    });
  } catch (error) {
    console.error("[goat-slack-bot] Answer generation or delivery failed", {
      integrationId: integration.id,
      channelId: input.channelId,
      mode,
      error: error instanceof Error ? error.message : String(error),
    });
    await status
      .fail("Something went wrong answering that. Try again in a minute.")
      .catch(() => {});
  }
  return "handled";
}

type BrainResolution =
  | { kind: "none" }
  | { kind: "targets"; targets: GoatBrainMultiBrainTarget[]; degradedToFallback: boolean };

async function resolveBrainTargets(
  integration: GoatSlackBotIntegrationForTeam,
  channelId: string,
  mode: SlackAnswerMode,
  sender: GoatSlackSenderResolution,
): Promise<BrainResolution & { degradedToFallback?: boolean }> {
  if (mode === "dm") {
    if (sender.kind !== "member") return { kind: "none" };
    const brains = await listAccessibleGoatBrains({
      userWorkosId: sender.member.workosUserId,
      workspaceId: integration.workspaceId,
    });
    if (brains.length === 0) return { kind: "none" };
    const ordered = [...brains].sort((a, b) =>
      a.slug === DEFAULT_GOAT_BRAIN_SLUG ? -1 : b.slug === DEFAULT_GOAT_BRAIN_SLUG ? 1 : 0,
    );
    return {
      kind: "targets",
      targets: ordered.map((brain) => ({ brainRef: brain.id, brainName: brain.name })),
      degradedToFallback: false,
    };
  }

  const routes = await listEnabledGoatSlackBotBrainRoutes(integration.id);
  const routed = routes.filter((route) =>
    goatSlackSelectedConversationIds(route.config).has(channelId),
  );
  if (routed.length === 0) return { kind: "none" };

  // A mapped member only reads brains they can access in the app. If none of
  // the routed brains are accessible to them, the whole turn degrades to the
  // workspace fallback identity so attribution stays coherent.
  if (sender.kind === "member") {
    const accessible = await listAccessibleGoatBrains({
      userWorkosId: sender.member.workosUserId,
      workspaceId: integration.workspaceId,
    });
    const accessibleIds = new Set(accessible.map((brain) => brain.id));
    const memberRouted = routed.filter((route) => accessibleIds.has(route.brainRef));
    if (memberRouted.length > 0) {
      return {
        kind: "targets",
        targets: memberRouted.map((route) => ({
          brainRef: route.brainRef,
          brainName: route.brainName,
        })),
        degradedToFallback: false,
      };
    }
    console.warn("[goat-slack-bot] Mapped member lacks access to routed brains; using fallback", {
      integrationId: integration.id,
      channelId,
    });
  }

  return {
    kind: "targets",
    targets: routed.map((route) => ({ brainRef: route.brainRef, brainName: route.brainName })),
    degradedToFallback: sender.kind === "member",
  };
}

// Drives the shared main-chat agent loop headlessly: same system prompt, same
// toolset (brain read, save_to_brain, web search, integration actions), no
// task/schedule tools, no persisted chat session — the Slack reply is the
// entire output.
async function runSlackChatAgent(input: {
  integration: GoatSlackBotIntegrationForTeam;
  identity: {
    userWorkosId: string;
    member: {
      email: string;
      firstName: string | null;
      lastName: string | null;
      timezone: string;
    } | null;
  };
  brains: GoatBrainMultiBrainTarget[];
  mode: SlackAnswerMode;
  status: GoatSlackBotStatusReporter;
  question: string;
  contextMessages: SlackContextMessage[];
  slackUserId: string;
  sourceRef: string;
  telemetrySessionId: string;
}) {
  const gatewayApiKey = requiredGatewayApiKey();
  const signal = AbortSignal.timeout(SLACK_AGENT_TIMEOUT_MS);
  const currentDate = new Date();

  const primaryBrain = input.brains[0];
  if (!primaryBrain) throw new Error("Slack bot agent needs at least one brain.");
  const multiBrain = input.brains.length > 1;
  const brainByRef = new Map(input.brains.map((brain) => [brain.brainRef, brain]));

  const userContext = input.identity.member
    ? {
        email: input.identity.member.email,
        firstName: input.identity.member.firstName,
        lastName: input.identity.member.lastName,
        timezone: input.identity.member.timezone,
      }
    : ((await getGoatUserBasics(input.identity.userWorkosId)) ?? undefined);
  const userTimezone = userContext?.timezone || "UTC";

  // Never expose the installing admin's private integrations to an unmapped
  // Slack sender using the fallback identity. DMs already require a mapped
  // member; channel fallbacks remain limited to their explicitly routed brains.
  const actions = input.identity.member
    ? await resolveSlackActionDispatcher({
        userWorkosId: input.identity.userWorkosId,
        workspaceId: input.integration.workspaceId,
        status: input.status,
        signal,
        currentDate,
        userTimezone,
      })
    : null;

  const workspaceName = await getWorkspaceName(input.integration.workspaceId);

  // In channels the final turn names the asker like the reconstructed history
  // does, so the model knows who to address among several humans.
  const speakerName = input.identity.member
    ? [input.identity.member.firstName, input.identity.member.lastName]
        .filter(Boolean)
        .join(" ")
        .trim() || null
    : null;
  const finalUserContent =
    input.mode === "dm"
      ? input.question
      : `${
          speakerName
            ? `[${speakerName} (<@${input.slackUserId}>)]`
            : formatSpeaker(input.slackUserId)
        }: ${input.question}`;

  return runOpenCompanyChatAgent({
    messages: [...input.contextMessages, { role: "user", content: finalUserContent }],
    model: DEFAULT_GOAT_MODEL,
    gatewayApiKey,
    feature: "slack-bot",
    taskToolsEnabled: false,
    brainCaptureEnabled: true,
    activeBrain: {
      name: primaryBrain.brainName,
      workspaceName: workspaceName ?? "this workspace",
    },
    ...(actions ? { connectedIntegrations: actions.catalog.providers } : {}),
    extraSystemBlocks: [
      createGoatSlackSurfacePromptBlock({ isDirectMessage: input.mode === "dm" }),
    ],
    ...(multiBrain ? { goatBrainMultiBrain: { targets: input.brains } } : {}),
    userWorkosId: input.identity.userWorkosId,
    telemetrySessionId: input.telemetrySessionId,
    brainRef: primaryBrain.brainRef,
    currentDate,
    ...(userContext ? { userContext } : {}),
    abortSignal: signal,
    runBrainCli: async (args) => {
      input.status.setPhase("Searching the brain…");
      // Multi-brain turns receive raw args with a required `brain` enum value;
      // single-brain turns arrive already normalized from the tool context.
      const record = (args ?? {}) as Record<string, unknown>;
      const requestedBrain =
        multiBrain && typeof record.brain === "string" ? record.brain : primaryBrain.brainRef;
      const target = brainByRef.get(requestedBrain) ?? primaryBrain;
      const toolArgs = { ...record };
      delete toolArgs.brain;
      const normalized = multiBrain
        ? normalizeGoatBrainReadToolInput(toolArgs)
        : (args as Parameters<typeof runGoatBrainToolForUser>[0]["toolInput"]);
      return runGoatBrainToolForUser({
        brainRef: target.brainRef,
        userWorkosId: input.identity.userWorkosId,
        toolInput: normalized,
        gatewayApiKey,
        sourceRef: input.sourceRef,
        signal,
      });
    },
    saveToBrain: async (toolInput) => {
      input.status.setPhase("Saving to the brain…");
      const content = toolInput.content?.trim();
      const sourceRef = toolInput.sourceRef?.trim();
      if (!content && !sourceRef) {
        return { ok: false, error: "Provide content or sourceRef to save." };
      }
      const captured = await captureToGoatBrainInbox({
        brainRef: primaryBrain.brainRef,
        userWorkosId: input.identity.userWorkosId,
        ...(content ? { text: content } : {}),
        ...(toolInput.title ? { title: toolInput.title } : {}),
        ...(toolInput.intent ? { intent: toolInput.intent } : {}),
        ...(sourceRef ? { sourceRef } : {}),
        ...(toolInput.integrationId ? { integrationId: toolInput.integrationId } : {}),
        ...(toolInput.fallbackContent ? { fallbackText: toolInput.fallbackContent } : {}),
        source: {
          kind: "chat",
          connectionId: input.sourceRef,
          itemId: input.sourceRef,
        },
      });
      if (!captured.ok) return captured;
      return {
        ok: true,
        draftId: captured.draftBrainId,
        path: captured.path,
        title: captured.title,
        status: captured.quotaPaused ? "paused_by_plan" : "captured",
      };
    },
    ...(process.env.EXA_API_KEY?.trim()
      ? {
          webSearch: (toolInput) => {
            input.status.setPhase("Searching the web…");
            return executeGoatChatExaSearch({
              toolInput,
              apiKey: process.env.EXA_API_KEY?.trim() ?? "",
              signal,
              currentDate,
            });
          },
        }
      : {}),
    ...(actions ? { actions: actions.dispatcher } : {}),
  });
}

async function resolveSlackActionDispatcher(input: {
  userWorkosId: string;
  workspaceId: string;
  status: GoatSlackBotStatusReporter;
  signal: AbortSignal;
  currentDate: Date;
  userTimezone: string;
}) {
  if (isGoatChatActionsKilled()) return null;
  let catalog: GoatResolvedActionCatalog;
  try {
    const resolved = await resolveGoatActionCatalog({
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId,
    });
    // Slack has no tool-approval continuation UI. Keep actions the member has
    // explicitly enabled, and omit both "ask" actions and paid managed
    // capabilities, which require a persisted chat session for execution and
    // may return a confirmation card Slack cannot answer.
    catalog = projectActionCatalog(resolved, "headless");
  } catch {
    return null;
  }
  if (catalog.actions.length === 0) return null;

  const providerLabelById = new Map(
    catalog.providers.map((provider) => [provider.id, provider.label]),
  );
  return {
    catalog,
    dispatcher: {
      catalog: {
        sources: catalog.providers,
        actions: catalog.actions.map((action) => ({
          id: action.id,
          source: action.provider,
          description: action.description,
          params: action.params,
          permissionMode: action.permissionMode,
        })),
      },
      execute: async (call: {
        action: string;
        params: Record<string, unknown>;
        toolCallId: string;
      }): Promise<GoatActionResult> => {
        const provider = catalog.actions.find((action) => action.id === call.action)?.provider;
        input.status.setPhase(
          `Checking ${provider ? (providerLabelById.get(provider) ?? provider) : "integrations"}…`,
        );
        return executeGoatAction({
          catalog,
          actionId: call.action,
          params: call.params,
          userWorkosId: input.userWorkosId,
          signal: input.signal,
          currentDate: input.currentDate,
          userTimezone: input.userTimezone,
        });
      },
    },
  };
}

async function connectedIntegrations(teamId: string) {
  const integrations = await listGoatSlackBotIntegrationsForTeam(teamId);
  return integrations.filter((integration) => integration.status === "connected");
}

export function isDirectMessageChannel(channelId: string) {
  return channelId.startsWith("D");
}

async function getWorkspaceName(workspaceId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ name: goatWorkspaces.name })
    .from(goatWorkspaces)
    .where(eq(goatWorkspaces.id, workspaceId))
    .limit(1);
  return row?.name ?? null;
}

async function postPlainSlackReply(
  botToken: string,
  channelId: string,
  threadTs: string | null,
  text: string,
) {
  await slackApiRequest({
    method: "chat.postMessage",
    token: botToken,
    form: {
      channel: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text,
      unfurl_links: "false",
    },
  });
}

async function recordSlackBotUsage(input: {
  workspaceId: string;
  userWorkosId: string;
  model: string;
  usage: LanguageModelUsage | undefined;
  idempotencyKey: string;
}) {
  if (!input.usage) return;
  const cost = calculateModelUsageCost({
    modelName: input.model,
    inputTokens: readUsageNumber(input.usage.inputTokens),
    inputNoCacheTokens: readUsageNumber(input.usage.inputTokenDetails?.noCacheTokens),
    inputCacheReadTokens: readUsageNumber(input.usage.inputTokenDetails?.cacheReadTokens),
    inputCacheWriteTokens: readUsageNumber(input.usage.inputTokenDetails?.cacheWriteTokens),
    outputTokens: readUsageNumber(input.usage.outputTokens),
  });
  recordGoatModelCost({
    costUsdMicros: cost.totalCostUsdMicros,
    attributes: {
      "goat.model": input.model,
      "goat.surface": "slack_bot",
    },
  });
  if (!cost.billable) return;
  // A debit failure must never block the already-posted answer.
  try {
    const debit = await recordGoatCreditDebit({
      workspaceId: input.workspaceId,
      userWorkosId: input.userWorkosId,
      source: "chat_model_usage",
      idempotencyKey: input.idempotencyKey,
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
      metadata: { surface: "slack_bot" },
    });
    if (debit.ok) {
      await captureGoatModelSpendRecorded({
        userWorkosId: input.userWorkosId,
        workspaceId: input.workspaceId,
        billingSource: "chat_model_usage",
        surface: "slack_bot",
        model: input.model,
        providerCostUsdMicros: cost.providerCostUsdMicros,
        platformFeeUsdMicros: cost.platformFeeUsdMicros,
        totalCostUsdMicros: cost.totalCostUsdMicros,
        modelCostUsdMicros: cost.providerCostUsdMicros,
        ledgerId: debit.ledgerId,
      });
    }
  } catch (error) {
    console.error("[goat-slack-bot] Credit debit failed", {
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readUsageNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function requiredGatewayApiKey() {
  const value = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!value) throw new Error("VERCEL_AI_GATEWAY_API_KEY is required for the Slack bot.");
  return value;
}

function logAnswerFailure(
  mode: SlackAnswerMode,
  integrationId: string,
  input: GoatSlackBotEventInput,
  error: unknown,
) {
  console.error("[goat-slack-bot] Failed to answer", {
    mode,
    teamId: input.teamId,
    channelId: input.channelId,
    integrationId,
    error: error instanceof Error ? error.message : String(error),
  });
}
