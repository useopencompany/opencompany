"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import type { GranolaProviderState } from "@/lib/integration-state";
import {
  connectGranolaIntegration,
  getGranolaIntegrationState,
  isValidGranolaApiKey,
  validateGranolaApiKey,
} from "@/lib/integrations/granola";

export type GranolaConnectActionResult =
  | { ok: true; state: GranolaProviderState }
  | { ok: false; error: string };

export async function saveGranolaApiKeyAction(apiKey: string): Promise<GranolaConnectActionResult> {
  const { user } = await currentUser();
  const trimmed = apiKey.trim();
  if (!isValidGranolaApiKey(trimmed)) {
    return { ok: false, error: "Granola API keys start with grn_. Check the key and try again." };
  }
  try {
    const validation = await validateGranolaApiKey(trimmed);
    if (!validation.ok) return { ok: false, error: validation.error };
    await connectGranolaIntegration({
      userWorkosId: user.workosUserId,
      apiKey: trimmed,
      accountEmail: validation.accountEmail,
      accountName: validation.accountName,
    });
    revalidatePath("/", "layout");
    return { ok: true, state: await getGranolaIntegrationState(user.workosUserId) };
  } catch (error) {
    console.error("[granola] Failed to save Granola API key", error);
    return {
      ok: false,
      error: "Could not save the Granola API key.",
    };
  }
}
