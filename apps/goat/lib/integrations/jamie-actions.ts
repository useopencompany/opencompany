"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { captureGoatIntegrationAddedAnalytics } from "@/lib/integrations/analytics";
import {
  createOrResetGoatJamieWebhookEndpoint,
  type GoatJamieWebhookSetup,
  saveGoatJamieWebhookApiKey,
} from "@/lib/integrations/jamie";

export type JamieWebhookEndpointActionResult =
  | {
      ok: true;
      setup: GoatJamieWebhookSetup;
    }
  | {
      ok: false;
      error: string;
    };

export async function createOrResetJamieWebhookEndpointAction(): Promise<JamieWebhookEndpointActionResult> {
  const { user, workspace, role } = await currentGoatUser();
  // Jamie webhooks are workspace-owned plumbing; only admins manage them.
  if (role !== "admin") {
    return { ok: false, error: "Only workspace admins can manage the Jamie integration." };
  }
  try {
    const setup = await createOrResetGoatJamieWebhookEndpoint({
      userWorkosId: user.workosUserId,
      workspaceId: workspace.id,
    });
    revalidatePath("/", "layout");
    return {
      ok: true,
      setup,
    };
  } catch (error) {
    console.error("[goat-jamie] Failed to create Jamie webhook endpoint", error);
    return {
      ok: false,
      error: "Could not create a Jamie webhook endpoint.",
    };
  }
}

export async function saveJamieWebhookApiKeyAction(
  apiKey: string,
): Promise<JamieWebhookEndpointActionResult> {
  const { user, workspace, role } = await currentGoatUser();
  if (role !== "admin") {
    return { ok: false, error: "Only workspace admins can manage the Jamie integration." };
  }
  try {
    const setup = await saveGoatJamieWebhookApiKey({
      workspaceId: workspace.id,
      apiKey,
    });
    await captureGoatIntegrationAddedAnalytics({
      userWorkosId: user.workosUserId,
      workspaceId: workspace.id,
      provider: "jamie",
    });
    revalidatePath("/", "layout");
    return {
      ok: true,
      setup,
    };
  } catch (error) {
    console.error("[goat-jamie] Failed to save Jamie webhook API key", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save the Jamie API key.",
    };
  }
}
