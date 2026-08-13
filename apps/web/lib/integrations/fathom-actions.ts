"use server";

import { revalidatePath } from "next/cache";
import type { GoatFathomProviderState } from "@/lib/integration-state";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type FathomConnectActionResult =
  | { ok: true; state: GoatFathomProviderState }
  | { ok: false; error: string };

export async function saveFathomApiKeyAction(apiKey: string): Promise<FathomConnectActionResult> {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return {
      ok: false,
      error: "This does not look like a Fathom API key. Check it and try again.",
    };
  }
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"].fathom.$put({
      json: { apiKey },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not save the Fathom API key."),
      };
    }
    const data = (await response.json()).data as { state: GoatFathomProviderState };
    revalidatePath("/", "layout");
    return { ok: true, state: data.state };
  } catch (error) {
    console.error("[goat-fathom] Failed to save Fathom API key", error);
    return { ok: false, error: "Could not save the Fathom API key." };
  }
}
