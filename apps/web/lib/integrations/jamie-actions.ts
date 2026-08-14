"use server";

import type { JamieWebhookSetup } from "@opencompany/agent/integrations/jamie";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type JamieWebhookEndpointActionResult =
  | {
      ok: true;
      setup: JamieWebhookSetup;
    }
  | {
      ok: false;
      error: string;
    };

export async function createOrResetJamieWebhookEndpointAction(): Promise<JamieWebhookEndpointActionResult> {
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"].jamie[
      "webhook-endpoint"
    ].$post();
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not create a Jamie webhook endpoint."),
      };
    }
    const data = (await response.json()).data as { setup: JamieWebhookSetup };
    revalidatePath("/", "layout");
    return { ok: true, setup: data.setup };
  } catch (error) {
    console.error("[opencompany-jamie] Failed to create Jamie webhook endpoint", error);
    return { ok: false, error: "Could not create a Jamie webhook endpoint." };
  }
}

export async function saveJamieWebhookApiKeyAction(
  apiKey: string,
): Promise<JamieWebhookEndpointActionResult> {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "Could not save the Jamie API key." };
  }
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"].jamie[
      "api-key"
    ].$put({ json: { apiKey } });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not save the Jamie API key."),
      };
    }
    const data = (await response.json()).data as { setup: JamieWebhookSetup };
    revalidatePath("/", "layout");
    return { ok: true, setup: data.setup };
  } catch (error) {
    console.error("[opencompany-jamie] Failed to save Jamie webhook API key", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save the Jamie API key.",
    };
  }
}
