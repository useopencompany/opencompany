"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { JamieEventsProviderState } from "@/lib/integration-state";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type JamieEventsActionResult =
  | { ok: true; state: JamieEventsProviderState }
  | { ok: false; error: string };

export async function createJamieWebhookEndpointAction(): Promise<JamieEventsActionResult> {
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"][
      "jamie-events"
    ].endpoint.$post({}, { headers: { "idempotency-key": randomUUID() } });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(
          response,
          "Could not create the Jamie webhook endpoint.",
        ),
      };
    }
    const data = (await response.json()).data as { state: JamieEventsProviderState };
    revalidatePath("/", "layout");
    return { ok: true, state: data.state };
  } catch (error) {
    console.error("[opencompany-jamie] Failed to create the Jamie webhook endpoint", error);
    return { ok: false, error: "Could not create the Jamie webhook endpoint." };
  }
}

export async function saveJamieWebhookKeyAction(
  webhookKey: string,
): Promise<JamieEventsActionResult> {
  if (typeof webhookKey !== "string" || !webhookKey.trim()) {
    return { ok: false, error: "Jamie webhook keys start with sk_. Check the key and try again." };
  }
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"][
      "jamie-events"
    ].$put({ json: { apiKey: webhookKey } });
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
    console.error("[opencompany-jamie] Failed to save the Jamie webhook key", error);
    return { ok: false, error: "Could not save the Jamie webhook key." };
  }
}
