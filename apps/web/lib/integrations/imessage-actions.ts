"use server";

import { revalidatePath } from "next/cache";
import type { GoatImessageProviderState } from "@/lib/integration-state";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type ImessagePairingActionResult = { ok: true } | { ok: false; error: string };

export type ImessageConfirmActionResult =
  | { ok: true; state: GoatImessageProviderState }
  | { ok: false; error: string };

export async function startImessagePairingAction(
  phone: string,
): Promise<ImessagePairingActionResult> {
  if (typeof phone !== "string" || !phone.trim()) {
    return {
      ok: false,
      error: "Enter the number in international format, e.g. +14155551234.",
    };
  }
  try {
    const response = await (await serverApiClient()).v1[
      "integration-accounts"
    ].imessage.pairing.$post({ json: { phone } });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not send the verification code."),
      };
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
  if (typeof code !== "string" || !code.trim()) {
    return { ok: false, error: "Enter the 6-digit code from the message." };
  }
  try {
    const response = await (await serverApiClient()).v1[
      "integration-accounts"
    ].imessage.pairing.confirm.$post({ json: { code } });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not verify the code."),
      };
    }
    const data = (await response.json()).data as { state: GoatImessageProviderState };
    revalidatePath("/", "layout");
    return { ok: true, state: data.state };
  } catch (error) {
    console.error("[goat-imessage] Failed to confirm pairing", error);
    return { ok: false, error: "Could not verify the code." };
  }
}
