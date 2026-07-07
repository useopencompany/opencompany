"use server";

import { currentGoatUser } from "@/lib/auth";
import {
  createOrResetGoatJamieWebhookEndpoint,
  type GoatJamieWebhookSetup,
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
  const { user } = await currentGoatUser();
  try {
    return {
      ok: true,
      setup: await createOrResetGoatJamieWebhookEndpoint({
        userWorkosId: user.workosUserId,
      }),
    };
  } catch (error) {
    console.error("[goat-jamie] Failed to create Jamie webhook endpoint", error);
    return {
      ok: false,
      error: "Could not create a Jamie webhook endpoint.",
    };
  }
}
