import { countGoatImessageSendsSince, recordGoatImessageSend } from "@opencompany/db/goat-imessage";
import type { GoatImessageSendSource } from "@opencompany/db/goat-schema";
import { resolveGoatImessageProvider } from "./provider";

const DEFAULT_DAILY_SEND_CAP = 30;
const MAX_MESSAGE_LENGTH = 500;

export type SendUserMessageResult = { ok: true; delivered: true } | { ok: false; error: string };

export type SendUserMessageRunner = (message: string) => Promise<SendUserMessageResult>;

function dailySendCap(): number {
  const parsed = Number.parseInt(process.env.GOAT_IMESSAGE_DAILY_CAP ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_SEND_CAP;
}

// Shared executor behind the send_user_message tool: same rate limit, audit
// trail, and error surface across the chat route and runner task executors.
// Never throws — failures come back as tool output for the model to relay.
export function createGoatSendUserMessageRunner(input: {
  userWorkosId: string;
  phoneE164: string;
  source: Exclude<GoatImessageSendSource, "pairing">;
  chatSessionId?: string;
  signal?: AbortSignal;
}): SendUserMessageRunner {
  return async (message) => {
    try {
      const text = message.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text) {
        return { ok: false, error: "Message text is empty." };
      }
      const provider = resolveGoatImessageProvider();
      if (!provider) {
        return { ok: false, error: "iMessage sending is not available right now." };
      }
      const cap = dailySendCap();
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const sentToday = await countGoatImessageSendsSince(input.userWorkosId, since);
      if (sentToday >= cap) {
        return {
          ok: false,
          error: `Daily iMessage limit reached (${cap} in 24h). Not sent.`,
        };
      }
      const result = await provider.send({
        to: input.phoneE164,
        text,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      await recordGoatImessageSend({
        userWorkosId: input.userWorkosId,
        source: input.source,
        status: result.ok ? "sent" : "failed",
        chatSessionId: input.chatSessionId ?? null,
        errorReason: result.ok ? null : result.error,
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true, delivered: true };
    } catch (error) {
      console.error("[goat-imessage] send_user_message failed", error);
      return { ok: false, error: "Sending failed unexpectedly." };
    }
  };
}
