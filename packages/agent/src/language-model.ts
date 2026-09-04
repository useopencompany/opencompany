import { getDb } from "@opencompany/db/client";
import { loadWorkspaceCodexEngineAccount } from "@opencompany/db/codex-auth";
import { createGateway, type LanguageModel } from "ai";
import {
  codexBackendProviderOptions,
  createCodexBackendLanguageModel,
} from "./codex-backend-language-model";

export const CODEX_SUBSCRIPTION_MODEL_IDS = [
  "openai/gpt-6-astra",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
] as const;

export type ProductModelFeature = "chat" | "task" | "slack-bot";
export type ProductModelBilling = "metered_gateway" | "subscription_covered";

export type ProductLanguageModelResolution = {
  model: LanguageModel;
  provider: "gateway" | "codex-backend";
  billing: ProductModelBilling;
  providerOptions?: ReturnType<typeof codexBackendProviderOptions>;
};

export function isCodexSubscriptionModel(modelId: string) {
  return (CODEX_SUBSCRIPTION_MODEL_IDS as readonly string[]).includes(modelId);
}

export async function resolveProductLanguageModel(input: {
  workspaceId: string;
  modelId: string;
  feature: ProductModelFeature;
  gatewayApiKey: string;
  db?: any;
  fetchImpl?: typeof fetch;
}): Promise<ProductLanguageModelResolution> {
  const db = input.db ?? getDb();
  if (isCodexSubscriptionModel(input.modelId)) {
    const account = await loadWorkspaceCodexEngineAccount({
      db,
      workspaceId: input.workspaceId,
    });
    if (account?.enabled) {
      return {
        model: createCodexBackendLanguageModel({
          db,
          userWorkosId: account.providerUserWorkosId,
          modelId: input.modelId,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
        provider: "codex-backend",
        billing: "subscription_covered",
        providerOptions: codexBackendProviderOptions(),
      };
    }
  }

  if (!input.gatewayApiKey.trim()) {
    throw new Error("VERCEL_AI_GATEWAY_API_KEY is required for metered model routing.");
  }
  const gateway = createGateway({ apiKey: input.gatewayApiKey });
  return {
    model: gateway(input.modelId),
    provider: "gateway",
    billing: "metered_gateway",
  };
}
