"use server";

import { revalidatePath } from "next/cache";
import type { GoatStripeProviderState } from "@/lib/integration-state";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type StripeConnectActionResult =
  | { ok: true; state: GoatStripeProviderState }
  | { ok: false; error: string };

export async function saveStripeRestrictedApiKeyAction(
  apiKey: string,
): Promise<StripeConnectActionResult> {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "Enter a restricted Stripe API key." };
  }
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"].stripe.$put({
      json: { apiKey },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(
          response,
          "Could not connect Stripe. Check the restricted key and try again.",
        ),
      };
    }
    const data = (await response.json()).data as { state: GoatStripeProviderState };
    revalidatePath("/", "layout");
    return { ok: true, state: data.state };
  } catch (error) {
    console.error("[goat-stripe] Failed to save Stripe restricted key", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      error: "Could not connect Stripe. Check the restricted key and try again.",
    };
  }
}

export async function disconnectStripeIntegrationAction(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"].stripe.$delete();
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not disconnect Stripe."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not disconnect Stripe.",
    };
  }
}
