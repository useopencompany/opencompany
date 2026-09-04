"use server";

import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type RenderConnectActionResult = { ok: true } | { ok: false; error: string };

export async function saveRenderApiKeyAction(apiKey: string): Promise<RenderConnectActionResult> {
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmed.startsWith("rnd_")) {
    return { ok: false, error: "Render API keys start with rnd_. Check the key and try again." };
  }
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"].render.$put({
      json: { apiKey: trimmed },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not save the Render API key."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    console.error("[opencompany-render] Failed to save Render API key", error);
    return { ok: false, error: "Could not save the Render API key." };
  }
}
