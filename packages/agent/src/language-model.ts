import { loadWorkspaceCodexEngineAccount } from "@opencompany/db/workspace-codex-engine";
import type { GatewayFeature } from "@opencompany/telemetry";
import { createGateway, type LanguageModel } from "ai";
import { createCodexBackendLanguageModel } from "./codex-backend-language-model";

const CODEX_SUBSCRIPTION_MODEL_IDS = new Set(["openai/gpt-5.6-sol", "openai/gpt-5.6-terra"]);
const CODEX_SUBSCRIPTION_FEATURES = new Set<GatewayFeature>(["chat", "task", "slack-bot"]);

type DbLike = any;

export type LanguageModelCostSource = "metered_gateway" | "subscription_covered";

export type ResolvedLanguageModel = {
  languageModel: LanguageModel;
  modelProvider: "vercel-ai-gateway" | "codex-subscription";
  costSource: LanguageModelCostSource;
  providerUserWorkosId: string | null;
};

export function isCodexSubscriptionEligibleModel(modelId: string) {
  return CODEX_SUBSCRIPTION_MODEL_IDS.has(modelId);
}

export async function resolveLanguageModel(input: {
  modelId: string;
  workspaceId?: string | null;
  feature: GatewayFeature;
  gatewayApiKey: string;
  db?: DbLike;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedLanguageModel> {
  const gateway = () => ({
    languageModel: createGateway({ apiKey: input.gatewayApiKey })(input.modelId),
    modelProvider: "vercel-ai-gateway" as const,
    costSource: "metered_gateway" as const,
    providerUserWorkosId: null,
  });

  if (
    !input.workspaceId ||
    !isCodexSubscriptionEligibleModel(input.modelId) ||
    !CODEX_SUBSCRIPTION_FEATURES.has(input.feature)
  ) {
    return gateway();
  }

  if (!input.db) {
    throw new Error("Workspace language-model routing requires a transaction-capable database.");
  }
  const db = input.db;
  const account = await loadWorkspaceCodexEngineAccount({
    workspaceId: input.workspaceId,
    db,
  });
  if (!account?.enabled) return gateway();

  return {
    languageModel: createCodexBackendLanguageModel({
      modelId: input.modelId,
      providerUserWorkosId: account.providerUserWorkosId,
      db,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    }),
    modelProvider: "codex-subscription",
    costSource: "subscription_covered",
    providerUserWorkosId: account.providerUserWorkosId,
  };
}
