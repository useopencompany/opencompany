"use client";

import {
  type CreateWikiBody,
  createApiClient,
  type SetWikiAccessBody,
  type UpdateWikiBody,
  type WikiAccessDetailsDto,
  type WikiDto,
} from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "@/lib/headless-chat-api";

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

export async function updateWiki(wikiId: string, body: UpdateWikiBody): Promise<WikiDto> {
  return data(
    await client().v1.wikis[":wikiId"].$patch({ param: { wikiId }, json: body }),
    "The wiki could not be updated. Please try again.",
  );
}

/** The wiki's access level, who is invited, and the workspace roster to pick from. */
export async function getWikiAccess(wikiId: string): Promise<WikiAccessDetailsDto> {
  return data(
    await client().v1.wikis[":wikiId"].access.$get({ param: { wikiId } }),
    "Wiki access could not be loaded.",
  );
}

export async function setWikiAccess(
  wikiId: string,
  body: SetWikiAccessBody,
): Promise<WikiAccessDetailsDto> {
  return data(
    await client().v1.wikis[":wikiId"].access.$put({ param: { wikiId }, json: body }),
    "Wiki access could not be saved. Please try again.",
  );
}
