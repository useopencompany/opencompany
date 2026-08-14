"use client";

import {
  type AddWikiTimelineEntryBody,
  type CreateWikiPageBody,
  createApiClient,
  type DeleteWikiPageBody,
  type UpdateWikiPageBody,
} from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

export type KnowledgeClientOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  scopeKey?: string;
};

export async function createWikiPageRequest(
  command: CreateWikiPageBody,
  options: KnowledgeClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.wiki.pages.$post({
    header: { "idempotency-key": `web-wiki-page:${crypto.randomUUID()}` },
    json: command,
  });
  return responseData(response, "Wiki page creation failed");
}

export async function updateWikiPageRequest(
  slug: string,
  command: UpdateWikiPageBody,
  options: KnowledgeClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.wiki.pages[":slug"].$patch({
    param: { slug },
    json: command,
  });
  return responseData(response, "Wiki page update failed");
}

export async function deleteWikiPageRequest(
  slug: string,
  command: DeleteWikiPageBody,
  options: KnowledgeClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.wiki.pages[":slug"].delete.$post({
    param: { slug },
    json: command,
  });
  return responseData(response, "Wiki page deletion failed");
}

export async function addWikiTimelineEntryRequest(
  slug: string,
  command: AddWikiTimelineEntryBody,
  options: KnowledgeClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.wiki.pages[":slug"].timeline.$post({
    param: { slug },
    header: { "idempotency-key": `web-wiki-timeline:${crypto.randomUUID()}` },
    json: command,
  });
  return responseData(response, "Wiki timeline update failed");
}

function knowledgeClient(options: KnowledgeClientOptions) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  return createApiClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
}

async function responseData<T>(
  response: Response & { json(): Promise<{ data: T }> },
  fallback: string,
) {
  if (!response.ok) throw await responseError(response, fallback);
  return (await response.json()).data;
}

async function responseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `${fallback} with HTTP ${response.status}.`}${requestId ? ` (request ${requestId})` : ""}`,
  );
}
