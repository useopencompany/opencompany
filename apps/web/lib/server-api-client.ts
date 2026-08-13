import "server-only";

import { createOpenCompanyClient } from "@opencompany/protocol";
import { headers } from "next/headers";

// Server-side typed /v1 client for Server Actions and Server Components.
// Forwards the caller's Cookie/Authorization credentials and browser Origin so
// the canonical API can enforce its cookie-mutation origin check.
export async function serverApiClient() {
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
  return createOpenCompanyClient(serverApiOrigin(process.env.GOAT_API_ORIGIN), {
    fetch: fetchWithActor,
  });
}

// The protocol error message alone — for user-facing form errors that should
// read exactly like the retired Server Action messages.
export async function serverApiErrorMessage(response: Response, fallback: string) {
  return (await parseErrorEnvelope(response)).message ?? fallback;
}

// An Error carrying the message plus the request id for thrown/logged paths.
export async function serverApiError(response: Response, fallback: string) {
  const { message, requestId } = await parseErrorEnvelope(response);
  return new Error(`${message ?? fallback}${requestId ? ` (request ${requestId})` : ""}`);
}

async function parseErrorEnvelope(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  return {
    message: typeof body?.error?.message === "string" ? body.error.message : null,
    requestId: typeof body?.error?.requestId === "string" ? body.error.requestId : null,
  };
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
