import {
  createGoatGatewayAttribution,
  goatGatewayProviderOptions,
} from "@opencompany/goat-observability";
import {
  createGateway,
  generateText,
  jsonSchema,
  type LanguageModelUsage,
  stepCountIs,
  tool,
} from "ai";
import { runGoatBrainToolForUser } from "@/lib/brain-cli";
import {
  GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
  normalizeGoatBrainReadToolInput,
} from "@/lib/brain-surface";
import { GOAT_BRAIN_TOOL_DESCRIPTION } from "@/lib/prompts";
import { createGoatSlackBotSystemPrompt } from "@/lib/prompts/slack-bot";

export const GOAT_SLACK_BOT_MODEL = "moonshotai/kimi-k2.6";
const GOAT_SLACK_BOT_MAX_STEPS = 6;

export type GoatSlackBotBrainTarget = {
  brainRef: string;
  brainName: string;
};

export type GoatSlackBotAgentResult = {
  text: string;
  model: string;
  usage: LanguageModelUsage | undefined;
};

// Single-brain channels use the shared read-tool schema unchanged; when
// several brains claim the channel the model must pick one per call via a
// required `brain` enum (one tool, not N mangled tool names).
export function buildGoatSlackBotToolSchema(brains: readonly GoatSlackBotBrainTarget[]) {
  const baseSchema = GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA as {
    properties: Record<string, unknown>;
    required: string[];
    [key: string]: unknown;
  };
  if (brains.length <= 1) return baseSchema;
  return {
    ...baseSchema,
    properties: {
      ...baseSchema.properties,
      brain: {
        type: "string",
        enum: brains.map((brain) => brain.brainRef),
        description: `Which brain to search. ${brains
          .map((brain) => `${brain.brainName}: ${brain.brainRef}`)
          .join("; ")}`,
      },
    },
    required: [...baseSchema.required, "brain"],
  };
}

// Headless single-question loop: no persisted chat session, read-only brain
// surface only. The Slack answer is the entire output.
export async function runGoatSlackBotAgent(input: {
  question: string;
  threadContext?: string | null;
  brains: GoatSlackBotBrainTarget[];
  gatewayApiKey: string;
  // The installing admin's id (integration row owner) — attribution and read
  // plane scoping key, not the person asking in Slack.
  userWorkosId: string;
  sourceRef: string;
}): Promise<GoatSlackBotAgentResult> {
  if (input.brains.length === 0) {
    throw new Error("Slack bot agent needs at least one brain.");
  }
  const gateway = createGateway({ apiKey: input.gatewayApiKey });
  const attribution = createGoatGatewayAttribution({
    userWorkosId: input.userWorkosId,
    feature: "slack-bot",
    brainRef: input.brains[0]?.brainRef,
  });

  const multiBrain = input.brains.length > 1;
  const brainRefById = new Map(input.brains.map((brain) => [brain.brainRef, brain]));
  const defaultBrainRef = input.brains[0]?.brainRef ?? "";
  const toolSchema = buildGoatSlackBotToolSchema(input.brains);

  const result = await generateText({
    model: gateway(GOAT_SLACK_BOT_MODEL),
    system: createGoatSlackBotSystemPrompt({
      brains: input.brains,
      currentDate: new Date().toISOString().slice(0, 10),
    }),
    messages: [
      {
        role: "user" as const,
        content: input.threadContext
          ? `${input.question}\n\nSlack thread context (earlier messages in this thread):\n${input.threadContext}`
          : input.question,
      },
    ],
    tools: {
      goat_brain: tool({
        description: GOAT_BRAIN_TOOL_DESCRIPTION,
        inputSchema: jsonSchema<Record<string, unknown>>(
          toolSchema as Parameters<typeof jsonSchema>[0],
        ),
        execute: async (args) => {
          const record = (args ?? {}) as Record<string, unknown>;
          const requestedBrain =
            multiBrain && typeof record.brain === "string" ? record.brain : defaultBrainRef;
          const target = brainRefById.get(requestedBrain) ?? input.brains[0];
          if (!target) throw new Error("goat_brain brain is invalid.");
          const toolArgs = { ...record };
          delete toolArgs.brain;
          const normalized = normalizeGoatBrainReadToolInput(toolArgs);
          return runGoatBrainToolForUser({
            brainRef: target.brainRef,
            userWorkosId: input.userWorkosId,
            toolInput: normalized,
            gatewayApiKey: input.gatewayApiKey,
            sourceRef: input.sourceRef,
          });
        },
      }),
    },
    stopWhen: stepCountIs(GOAT_SLACK_BOT_MAX_STEPS),
    providerOptions: goatGatewayProviderOptions(attribution),
  });

  return {
    text: result.text.trim() || "I couldn't find anything relevant in the brain for that.",
    model: GOAT_SLACK_BOT_MODEL,
    usage: result.totalUsage,
  };
}
