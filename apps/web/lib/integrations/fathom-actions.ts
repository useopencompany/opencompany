"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import type { GoatFathomProviderState } from "@/lib/integration-state";
import {
  connectGoatFathomIntegration,
  getGoatFathomIntegrationState,
  isValidFathomApiKey,
  validateGoatFathomApiKey,
} from "@/lib/integrations/fathom";

export type FathomConnectActionResult =
  | { ok: true; state: GoatFathomProviderState }
  | { ok: false; error: string };

export async function saveFathomApiKeyAction(apiKey: string): Promise<FathomConnectActionResult> {
  const { user } = await currentGoatUser();
  const trimmed = apiKey.trim();
  if (!isValidFathomApiKey(trimmed)) {
    return {
      ok: false,
      error: "This does not look like a Fathom API key. Check it and try again.",
    };
  }
  try {
    const validation = await validateGoatFathomApiKey(trimmed);
    if (!validation.ok) return { ok: false, error: validation.error };
    await connectGoatFathomIntegration({
      userWorkosId: user.workosUserId,
      apiKey: trimmed,
    });
    revalidatePath("/", "layout");
    return { ok: true, state: await getGoatFathomIntegrationState(user.workosUserId) };
  } catch (error) {
    console.error("[goat-fathom] Failed to save Fathom API key", error);
    return {
      ok: false,
      error: "Could not save the Fathom API key.",
    };
  }
}
