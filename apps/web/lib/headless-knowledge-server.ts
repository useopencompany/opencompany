import "server-only";

import {
  type BrainOverviewDto,
  type BrainSnapshotDto,
  createApiClient,
  type SkillCatalogItemDto,
  type SkillDto,
  type SkillListItemDto,
  type WikiPageDto,
} from "@opencompany/protocol";
import { headers } from "next/headers";

export async function getHeadlessBrainSnapshot(brainId: string): Promise<BrainSnapshotDto> {
  const response = await (await serverKnowledgeClient()).v1.brains[":brainId"].$get({
    param: { brainId },
  });
  if (!response.ok) throw await serverResponseError(response, "Brain loading failed");
  return (await response.json()).data;
}

export async function getHeadlessBrainOverview(brainId: string): Promise<BrainOverviewDto> {
  const response = await (await serverKnowledgeClient()).v1.brains[":brainId"].overview.$get({
    param: { brainId },
  });
  if (!response.ok) throw await serverResponseError(response, "Brain overview loading failed");
  return (await response.json()).data;
}

export async function listHeadlessWikiPages(): Promise<WikiPageDto[]> {
  const response = await (await serverKnowledgeClient()).v1.wiki.pages.$get();
  if (!response.ok) throw await serverResponseError(response, "Wiki loading failed");
  return (await response.json()).data;
}

export async function listHeadlessSkills(): Promise<SkillListItemDto[]> {
  const response = await (await serverKnowledgeClient()).v1.skills.$get();
  if (!response.ok) throw await serverResponseError(response, "Skill loading failed");
  return (await response.json()).data;
}

export async function listHeadlessSkillCatalog(): Promise<SkillCatalogItemDto[]> {
  const response = await (await serverKnowledgeClient()).v1.skills.catalog.$get();
  if (!response.ok) throw await serverResponseError(response, "Skill catalog loading failed");
  return (await response.json()).data;
}

export async function getHeadlessSkill(slug: string): Promise<SkillDto | null> {
  const response = await (await serverKnowledgeClient()).v1.skills[":slug"].$get({
    param: { slug },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await serverResponseError(response, "Skill loading failed");
  return (await response.json()).data;
}

async function serverKnowledgeClient() {
  const origin = serverApiOrigin(process.env.GOAT_API_ORIGIN);
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  const authorization = incoming.get("authorization");
  const fetchWithActor: typeof globalThis.fetch = async (input, init) => {
    const forwarded = new Headers(init?.headers);
    if (cookie) forwarded.set("Cookie", cookie);
    if (authorization) forwarded.set("Authorization", authorization);
    return globalThis.fetch(input, { ...init, headers: forwarded, cache: "no-store" });
  };
  return createApiClient(origin, { fetch: fetchWithActor });
}

function serverApiOrigin(value: string | undefined) {
  if (!value?.trim()) throw new Error("The canonical API origin is unavailable.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The canonical API origin is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("The canonical API origin is invalid.");
  }
  return url.origin;
}

async function serverResponseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `${fallback} with HTTP ${response.status}.`}${requestId ? ` (request ${requestId})` : ""}`,
  );
}
