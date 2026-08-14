"use server";

import {
  type BrainImportProvider,
  createApiClient,
  type StartBrainImportBody,
} from "@opencompany/protocol";
import { headers } from "next/headers";

export type BrainImportActionResult =
  | { ok: true; importRunId: string }
  | { ok: false; message: string };

export async function startBrainImportDiscoveryAction(input: {
  brainRef: string;
  companyUrl: string;
  focus?: string;
  sourceSelection: Record<
    string,
    { enabled: boolean; integrationId?: string; config?: Record<string, unknown> }
  >;
}): Promise<BrainImportActionResult> {
  return importCommand(async () => {
    const response = await (await serverImportClient()).v1.brains[":brainId"].imports.$post({
      param: { brainId: input.brainRef },
      header: { "idempotency-key": `web-brain-import:${crypto.randomUUID()}` },
      json: {
        companyUrl: input.companyUrl,
        ...(input.focus?.trim() ? { focus: input.focus } : {}),
        sourceSelection: protocolSourceSelection(input.sourceSelection),
      },
    });
    return response;
  }, "The company-context import failed.");
}

// The API only honors the requested GitHub repository scope; every other provider reuses its
// stored source configuration server-side, so the command sends only the fields the strict
// protocol schema defines.
function protocolSourceSelection(
  selection: Record<
    string,
    { enabled: boolean; integrationId?: string; config?: Record<string, unknown> }
  >,
): StartBrainImportBody["sourceSelection"] {
  const next: StartBrainImportBody["sourceSelection"] = {};
  for (const [provider, entry] of Object.entries(selection)) {
    const repos = Array.isArray(entry.config?.repos)
      ? entry.config.repos
          .flatMap((repo) => {
            if (!repo || typeof repo !== "object") return [];
            const { id, fullName } = repo as { id?: unknown; fullName?: unknown };
            const ref = {
              ...(typeof id === "string" && id ? { id } : {}),
              ...(typeof fullName === "string" && fullName ? { fullName } : {}),
            };
            return Object.keys(ref).length > 0 ? [ref] : [];
          })
          .slice(0, 20)
      : [];
    next[provider] = {
      enabled: entry.enabled,
      ...(entry.integrationId ? { integrationId: entry.integrationId } : {}),
      ...(repos.length > 0 ? { config: { repos } } : {}),
    };
  }
  return next;
}

export async function confirmBrainImportAction(input: {
  brainRef: string;
  importRunId: string;
  enabledProviders: BrainImportProvider[];
}): Promise<BrainImportActionResult> {
  return importCommand(
    async () =>
      (await serverImportClient()).v1.brains[":brainId"].imports[":importRunId"].confirm.$post({
        param: { brainId: input.brainRef, importRunId: input.importRunId },
        json: { enabledProviders: input.enabledProviders },
      }),
    "The company-context import failed.",
  );
}

export async function cancelBrainImportAction(input: {
  brainRef: string;
  importRunId: string;
}): Promise<BrainImportActionResult> {
  return importCommand(
    async () =>
      (await serverImportClient()).v1.brains[":brainId"].imports[":importRunId"].cancel.$post({
        param: { brainId: input.brainRef, importRunId: input.importRunId },
      }),
    "The company-context import failed.",
  );
}

export async function retryBrainImportDiscoveryAction(input: {
  brainRef: string;
  importRunId: string;
}): Promise<BrainImportActionResult> {
  return importCommand(
    async () =>
      (await serverImportClient()).v1.brains[":brainId"].imports[":importRunId"].retry.$post({
        param: { brainId: input.brainRef, importRunId: input.importRunId },
      }),
    "The company-context import failed.",
  );
}

async function importCommand(
  request: () => Promise<Response>,
  fallback: string,
): Promise<BrainImportActionResult> {
  try {
    const response = await request();
    if (!response.ok) {
      return { ok: false, message: (await responseError(response, fallback)).message };
    }
    const body = (await response.json()) as { data: { importRunId: string } };
    return { ok: true, importRunId: body.data.importRunId };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : fallback };
  }
}

async function serverImportClient() {
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  const authorization = incoming.get("authorization");
  const browserOrigin = incoming.get("origin");
  const fetchWithActor: typeof globalThis.fetch = async (input, init) => {
    const forwarded = new Headers(init?.headers);
    if (cookie) forwarded.set("Cookie", cookie);
    if (authorization) forwarded.set("Authorization", authorization);
    if (browserOrigin) forwarded.set("Origin", browserOrigin);
    return globalThis.fetch(input, { ...init, headers: forwarded, cache: "no-store" });
  };
  return createApiClient(apiOrigin(process.env.OPENCOMPANY_API_ORIGIN), {
    fetch: fetchWithActor,
  });
}

function apiOrigin(value: string | undefined) {
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

async function responseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : fallback;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(`${message}${requestId ? ` (request ${requestId})` : ""}`);
}
