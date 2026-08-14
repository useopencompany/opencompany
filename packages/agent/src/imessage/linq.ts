import type { ImessageProvider, ImessageSendResult } from "./provider";

const DEFAULT_LINQ_API_BASE_URL = "https://api.linqapp.com";

// Linq Partner API v3: one POST creates (or reuses) the chat and sends the
// message; Linq falls back from iMessage to RCS/SMS on its side.
export function createLinqImessageProvider(config: {
  token: string;
  fromNumber: string;
  baseUrl?: string | null;
}): ImessageProvider {
  const baseUrl = (config.baseUrl || DEFAULT_LINQ_API_BASE_URL).replace(/\/$/, "");
  return {
    name: "linq",
    send: async ({ to, text, signal }) => {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/api/partner/v3/chats`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: config.fromNumber,
            to: [to],
            message: { parts: [{ type: "text", value: text }] },
          }),
          signal: signal ?? AbortSignal.timeout(15_000),
        });
      } catch {
        return { ok: false, error: "Could not reach the message provider." };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: "Message provider rejected the platform credentials." };
      }
      if (!response.ok) {
        const kind = response.status >= 500 ? "is unavailable" : "rejected the send";
        return { ok: false, error: `Message provider ${kind} (HTTP ${response.status}).` };
      }
      return { ok: true, providerMessageId: await parseProviderMessageId(response) };
    },
  };
}

async function parseProviderMessageId(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { id?: unknown; message?: { id?: unknown } };
    if (typeof body.id === "string") return body.id;
    if (typeof body.message?.id === "string") return body.message.id;
  } catch {
    // A delivered send with an unparseable body is still a success.
  }
  return null;
}

export type { ImessageSendResult };
