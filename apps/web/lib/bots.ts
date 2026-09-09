"use client";
import { type BotDto, createApiClient } from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "@/lib/headless-chat-api";

function client() {
  const baseUrl = headlessChatApiBaseUrl();
  return createApiClient(baseUrl, { fetch: createHeadlessChatApiFetch({ baseUrl }) });
}
async function data<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? "Could not save or load bots. Please try again.");
  }
  return (await response.json()).data;
}
export async function listBots() {
  return data<BotDto[]>(await client().v1.bots.$get());
}
export async function saveBot(bot: BotDto, creating: boolean) {
  return data<BotDto>(
    creating
      ? await client().v1.bots.$post({ json: bot })
      : await client().v1.bots[":botId"].$patch({
          param: { botId: bot.id },
          json: { name: bot.name, description: bot.description },
        }),
  );
}
