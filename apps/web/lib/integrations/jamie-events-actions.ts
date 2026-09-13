"use server";

import { revalidatePath } from "next/cache";
import type { JamieEventsProviderState } from "@/lib/integration-state";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type JamieEventsConnectActionResult =
  | { ok: true; state: JamieEventsProviderState }
  | { ok: false; error: string };

export async function saveJamieWebhookKeyAction(
  apiKey: string,
): Promise<JamieEventsConnectActionResult> {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "Jamie webhook keys start with sk_. Check the key and try again." };
  }
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"][
      "jamie-events"
    ].$put({ json: { apiKey } });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not save the Jamie webhook key."),
      };
    }
    const data = (await response.json()).data as { state: JamieEventsProviderState };
    revalidatePath("/", "layout");
    return { ok: true, state: data.state };
  } catch (error) {
    console.error("[opencompany-jamie] Failed to save Jamie webhook key", error);
    return { ok: false, error: "Could not save the Jamie webhook key." };
  }
}
