"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import type { GoatGranolaProviderState } from "@/lib/integration-state";
import {
  connectGoatGranolaIntegration,
  getGoatGranolaIntegrationState,
  isValidGranolaApiKey,
  validateGoatGranolaApiKey,
} from "@/lib/integrations/granola";

export type GranolaConnectActionResult =
  | { ok: true; state: GoatGranolaProviderState }
  | { ok: false; error: string };

export async function saveGranolaApiKeyAction(apiKey: string): Promise<GranolaConnectActionResult> {
  const { user } = await currentGoatUser();
  const trimmed = apiKey.trim();
  if (!isValidGranolaApiKey(trimmed)) {
    return { ok: false, error: "Granola API keys start with grn_. Check the key and try again." };
  }
  try {
    const validation = await validateGoatGranolaApiKey(trimmed);
    if (!validation.ok) return { ok: false, error: validation.error };
    await connectGoatGranolaIntegration({
      userWorkosId: user.workosUserId,
      apiKey: trimmed,
      accountEmail: validation.accountEmail,
      accountName: validation.accountName,
    });
    revalidatePath("/", "layout");
    return { ok: true, state: await getGoatGranolaIntegrationState(user.workosUserId) };
  } catch (error) {
    console.error("[goat-granola] Failed to save Granola API key", error);
    return {
      ok: false,
      error: "Could not save the Granola API key.",
    };
  }
}
