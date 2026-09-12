"use client";

import { type CreateWikiBody, createApiClient, type WikiDto } from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "@/lib/headless-chat-api";

export const WIKIS_CHANGED_EVENT = "opencompany:wikis-changed";

function client() {
  const baseUrl = headlessChatApiBaseUrl();
  return createApiClient(baseUrl, { fetch: createHeadlessChatApiFetch({ baseUrl }) });
}

async function data<T>(
  response: Response & { json(): Promise<{ data: T }> },
  fallback: string,
): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: unknown };
    } | null;
    const message = typeof body?.error?.message === "string" ? body.error.message : null;
    throw new Error(message ?? fallback);
  }
  return (await response.json()).data;
}

/** Every wiki in the workspace the reader may open, the default one first. */
export async function listWikis(): Promise<WikiDto[]> {
  return data(await client().v1.wikis.$get(), "Wikis could not be loaded.");
}

export async function createWiki(body: CreateWikiBody): Promise<WikiDto> {
  return data(
    await client().v1.wikis.$post({ json: body }),
    "The wiki could not be created. Please try again.",
  );
}
