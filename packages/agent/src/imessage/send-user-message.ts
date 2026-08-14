import {
  countImessageSendsSince,
  getSuccessfulImessageSendForTurn,
  recordImessageSend,
} from "@opencompany/db/imessage";
import type { ImessageSendSource } from "@opencompany/db/product-schema";
import { resolveImessageProvider } from "./provider";

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
export function createSendUserMessageRunner(input: {
  userWorkosId: string;
  phoneE164: string;
  source: Exclude<ImessageSendSource, "pairing">;
  chatSessionId?: string;
  turnId?: string;
  signal?: AbortSignal;
}): SendUserMessageRunner {
  return async (message) => {
    try {
      const text = message.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text) {
        return { ok: false, error: "Message text is empty." };
      }
      const provider = resolveImessageProvider();
      if (!provider) {
        return { ok: false, error: "iMessage sending is not available right now." };
      }
      if (input.turnId) {
        const existingSend = await getSuccessfulImessageSendForTurn(input.turnId);
        if (existingSend) return { ok: true, delivered: true };
      }
      const cap = dailySendCap();
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const sentToday = await countImessageSendsSince(input.userWorkosId, since);
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
      await recordImessageSend({
        userWorkosId: input.userWorkosId,
        source: input.source,
        status: result.ok ? "sent" : "failed",
        chatSessionId: input.chatSessionId ?? null,
        turnId: input.turnId ?? null,
        errorReason: result.ok ? null : result.error,
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true, delivered: true };
    } catch (error) {
      console.error("[opencompany-imessage] send_user_message failed", error);
      return { ok: false, error: "Sending failed unexpectedly." };
    }
  };
}
