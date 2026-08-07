"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import type { FathomProviderState } from "@/lib/integration-state";
import {
  connectFathomIntegration,
  getFathomIntegrationState,
  isValidFathomApiKey,
  validateFathomApiKey,
} from "@/lib/integrations/fathom";

export type FathomConnectActionResult =
  | { ok: true; state: FathomProviderState }
  | { ok: false; error: string };

export async function saveFathomApiKeyAction(apiKey: string): Promise<FathomConnectActionResult> {
  const { user } = await currentUser();
  const trimmed = apiKey.trim();
  if (!isValidFathomApiKey(trimmed)) {
    return {
      ok: false,
      error: "This does not look like a Fathom API key. Check it and try again.",
    };
  }
  try {
    const validation = await validateFathomApiKey(trimmed);
    if (!validation.ok) return { ok: false, error: validation.error };
    await connectFathomIntegration({
      userWorkosId: user.workosUserId,
      apiKey: trimmed,
    });
    revalidatePath("/", "layout");
    return { ok: true, state: await getFathomIntegrationState(user.workosUserId) };
  } catch (error) {
    console.error("[goat-fathom] Failed to save Fathom API key", error);
    return {
      ok: false,
      error: "Could not save the Fathom API key.",
    };
  }
}
