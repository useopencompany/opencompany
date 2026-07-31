"use server";

import { createHash, randomInt } from "node:crypto";
import {
  consumeGoatImessageChallenge,
  getGoatImessagePairingChallenge,
  incrementGoatImessageChallengeAttempts,
  recordGoatImessageSend,
  upsertGoatImessagePairingChallenge,
} from "@opencompany/db/goat-imessage";
import { resolveGoatImessageProvider } from "@opencompany/goat-agent/imessage/provider";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import type { GoatImessageProviderState } from "@/lib/integration-state";
import {
  connectGoatImessageIntegration,
  getGoatImessageIntegrationState,
  normalizeImessagePhoneE164,
} from "@/lib/integrations/imessage";

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_CONFIRM_ATTEMPTS = 5;

export type ImessagePairingActionResult = { ok: true } | { ok: false; error: string };

export type ImessageConfirmActionResult =
  | { ok: true; state: GoatImessageProviderState }
  | { ok: false; error: string };

function hashPairingCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export async function startImessagePairingAction(
  phone: string,
): Promise<ImessagePairingActionResult> {
  const { user } = await currentGoatUser();
  if (!user.imessageEnabled) {
    return { ok: false, error: "Enable iMessage notifications in Preferences first." };
  }
  const provider = resolveGoatImessageProvider();
  if (!provider) {
    return { ok: false, error: "iMessage sending is not configured on this environment." };
  }
  const phoneE164 = normalizeImessagePhoneE164(phone);
  if (!phoneE164) {
    return {
      ok: false,
      error: "Enter the number in international format, e.g. +14155551234.",
    };
  }

  try {
    const existing = await getGoatImessagePairingChallenge(user.workosUserId);
    if (
      existing &&
      !existing.consumedAt &&
      Date.now() - existing.createdAt.getTime() < RESEND_COOLDOWN_MS
    ) {
      return {
        ok: false,
        error: "A code was just sent. Wait a moment before requesting another.",
      };
    }

    const code = String(randomInt(100000, 1000000));
    await upsertGoatImessagePairingChallenge({
      userWorkosId: user.workosUserId,
      phoneE164,
      codeHash: hashPairingCode(code),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });

    const sendResult = await provider.send({
      to: phoneE164,
      text: `Your OpenCompany verification code is ${code}. It expires in 10 minutes.`,
    });
    await recordGoatImessageSend({
      userWorkosId: user.workosUserId,
      source: "pairing",
      status: sendResult.ok ? "sent" : "failed",
      errorReason: sendResult.ok ? null : sendResult.error,
    });
    if (!sendResult.ok) {
      return { ok: false, error: sendResult.error };
    }
    return { ok: true };
  } catch (error) {
    console.error("[goat-imessage] Failed to start pairing", error);
    return { ok: false, error: "Could not send the verification code." };
  }
}

export async function confirmImessagePairingAction(
  code: string,
): Promise<ImessageConfirmActionResult> {
  const { user } = await currentGoatUser();
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    return { ok: false, error: "Enter the 6-digit code from the message." };
  }

  try {
    const challenge = await getGoatImessagePairingChallenge(user.workosUserId);
    if (!challenge || challenge.consumedAt) {
      return { ok: false, error: "No pending verification. Request a new code." };
    }
    if (challenge.expiresAt.getTime() < Date.now()) {
      return { ok: false, error: "That code expired. Request a new one." };
    }
    if (challenge.attemptCount >= MAX_CONFIRM_ATTEMPTS) {
      return { ok: false, error: "Too many attempts. Request a new code." };
    }
    if (hashPairingCode(trimmed) !== challenge.codeHash) {
      await incrementGoatImessageChallengeAttempts(challenge.id);
      const remaining = MAX_CONFIRM_ATTEMPTS - challenge.attemptCount - 1;
      return {
        ok: false,
        error:
          remaining > 0
            ? `That code doesn't match. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`
            : "That code doesn't match. Request a new code.",
      };
    }

    await consumeGoatImessageChallenge(challenge.id);
    await connectGoatImessageIntegration({
      userWorkosId: user.workosUserId,
      phoneE164: challenge.phoneE164,
    });
    revalidatePath("/", "layout");
    return { ok: true, state: await getGoatImessageIntegrationState(user.workosUserId) };
  } catch (error) {
    console.error("[goat-imessage] Failed to confirm pairing", error);
    return { ok: false, error: "Could not verify the code." };
  }
}
