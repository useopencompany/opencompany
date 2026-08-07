"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import type { StripeProviderState } from "@/lib/integration-state";
import {
  connectStripeIntegration,
  disconnectStripeIntegration,
  getStripeIntegrationState,
  isValidStripeRestrictedApiKey,
  validateStripeRestrictedApiKey,
} from "@/lib/integrations/stripe";

export type StripeConnectActionResult =
  | { ok: true; state: StripeProviderState }
  | { ok: false; error: string };

export async function saveStripeRestrictedApiKeyAction(
  apiKey: string,
): Promise<StripeConnectActionResult> {
  const context = await currentUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can manage the Stripe integration." };
  }

  if (typeof apiKey !== "string") {
    return { ok: false, error: "Enter a restricted Stripe API key." };
  }
  const trimmed = apiKey.trim();
  if (!isValidStripeRestrictedApiKey(trimmed)) {
    return {
      ok: false,
      error:
        "Use a restricted Stripe key beginning with rk_test_ or rk_live_. Unrestricted sk_ keys are not accepted.",
    };
  }

  try {
    const validation = await validateStripeRestrictedApiKey(trimmed);
    if (!validation.ok) return validation;
    await connectStripeIntegration({
      userWorkosId: context.user.workosUserId,
      workspaceId: context.workspace.id,
      apiKey: trimmed,
      identity: validation.identity,
    });
    revalidatePath("/", "layout");
    return {
      ok: true,
      state: await getStripeIntegrationState(context.workspace.id),
    };
  } catch (error) {
    console.error("[stripe] Failed to save Stripe restricted key", {
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
  const context = await currentUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can manage the Stripe integration." };
  }
  try {
    const disconnected = await disconnectStripeIntegration(context.workspace.id);
    if (!disconnected) return { ok: false, error: "Stripe is not connected." };
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not disconnect Stripe.",
    };
  }
}
