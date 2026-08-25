"use client";

import {
  createApiClient,
  type UpsertWikiSourceBody,
  type WikiIngestActivityPageDto,
  type WikiSourceDto,
} from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

type ClientOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export async function listWikiSources(options: ClientOptions = {}): Promise<WikiSourceDto[]> {
  const response = await wikiSourceClient(options).v1.wiki.sources.$get();
  return responseData(response, "Wiki sources could not be loaded");
}

export async function listWikiIngestActivity(
  input: { limit?: number; cursor?: string } = {},
  options: ClientOptions = {},
): Promise<WikiIngestActivityPageDto> {
  const response = await wikiSourceClient(options).v1.wiki.sources.activity.$get({
    query: {
      limit: String(input.limit ?? 20),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    },
  });
  return responseData(response, "Wiki ingestion activity could not be loaded");
}

export async function upsertWikiSource(
  command: UpsertWikiSourceBody,
  options: ClientOptions = {},
): Promise<WikiSourceDto> {
  const response = await wikiSourceClient(options).v1.wiki.sources.$put({ json: command });
  return responseData(response, "Wiki source could not be updated");
}

export async function setWikiSourceEnabled(
  sourceId: string,
  enabled: boolean,
  options: ClientOptions = {},
): Promise<WikiSourceDto> {
  const response = await wikiSourceClient(options).v1.wiki.sources[":sourceId"].$patch({
    param: { sourceId },
    json: { enabled },
  });
  return responseData(response, "Wiki source could not be updated");
}

export async function deleteWikiSource(
  sourceId: string,
  options: ClientOptions = {},
): Promise<void> {
  const response = await wikiSourceClient(options).v1.wiki.sources[":sourceId"].$delete({
    param: { sourceId },
  });
  await responseData(response, "Wiki source could not be removed");
}

function wikiSourceClient(options: ClientOptions) {
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
  if (!response.ok) throw await wikiSourceResponseError(response, fallback);
  return (await response.json()).data;
}

async function wikiSourceResponseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `${fallback} (HTTP ${response.status}).`}${requestId ? ` (request ${requestId})` : ""}`,
  );
}
