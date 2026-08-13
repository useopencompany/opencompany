"use server";

import { revalidatePath } from "next/cache";
import type { GoatGranolaProviderState } from "@/lib/integration-state";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type GranolaConnectActionResult =
  | { ok: true; state: GoatGranolaProviderState }
  | { ok: false; error: string };

export async function saveGranolaApiKeyAction(apiKey: string): Promise<GranolaConnectActionResult> {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "Granola API keys start with grn_. Check the key and try again." };
  }
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"].granola.$put({
      json: { apiKey },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not save the Granola API key."),
      };
    }
    const data = (await response.json()).data as { state: GoatGranolaProviderState };
    revalidatePath("/", "layout");
    return { ok: true, state: data.state };
  } catch (error) {
    console.error("[goat-granola] Failed to save Granola API key", error);
    return { ok: false, error: "Could not save the Granola API key." };
  }
}
