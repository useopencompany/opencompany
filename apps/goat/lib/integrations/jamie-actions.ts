"use server";

import { currentGoatUser } from "@/lib/auth";
import {
  createOrRotateGoatJamieWebhookSecret,
  type GoatJamieWebhookSetup,
} from "@/lib/integrations/jamie";

export type JamieWebhookSecretActionResult =
  | {
      ok: true;
      setup: GoatJamieWebhookSetup;
    }
  | {
      ok: false;
      error: string;
    };

export async function createOrRotateJamieWebhookSecretAction(): Promise<JamieWebhookSecretActionResult> {
  const { user } = await currentGoatUser();
  try {
    return {
      ok: true,
      setup: await createOrRotateGoatJamieWebhookSecret({
        userWorkosId: user.workosUserId,
      }),
    };
  } catch (error) {
    console.error("[goat-jamie] Failed to create Jamie webhook secret", error);
    return {
      ok: false,
      error: "Could not generate a Jamie webhook secret.",
    };
  }
}
