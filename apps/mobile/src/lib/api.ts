import { fetch as expoFetch } from "expo/fetch";
import type { GoatChatView, GoatSessionSummary } from "@/lib/chat-types";
import { GOAT_API_URL } from "@/lib/config";

export type GetAccessToken = () => Promise<string | null>;

// Streaming-capable fetch that injects the bearer token. Used both for plain
// JSON calls and as the fetch implementation of the chat stream transport.
export function createAuthedFetch(getAccessToken: GetAccessToken): typeof globalThis.fetch {
  const authedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = await getAccessToken();
    const headers = new Headers(init?.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return expoFetch(input as never, { ...init, headers } as never) as unknown as Promise<Response>;
  };
  return authedFetch as typeof globalThis.fetch;
}

async function getJson<T>(path: string, getAccessToken: GetAccessToken): Promise<T> {
  const doFetch = createAuthedFetch(getAccessToken);
  const response = await doFetch(`${GOAT_API_URL}${path}`);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function fetchSessions(getAccessToken: GetAccessToken) {
  const data = await getJson<{ sessions: GoatSessionSummary[] }>(
    "/api/mobile/sessions",
    getAccessToken,
  );
  return data.sessions;
}

export async function fetchChat(sessionId: string, getAccessToken: GetAccessToken) {
  const data = await getJson<{ chat: GoatChatView }>(
    `/api/mobile/sessions/${encodeURIComponent(sessionId)}`,
    getAccessToken,
  );
  return data.chat;
}
