"use server";

import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type ConvexConnectActionResult = { ok: true } | { ok: false; error: string };

export async function saveConvexApiKeyAction(apiKey: string): Promise<ConvexConnectActionResult> {
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!/^(dev|prod):/.test(trimmed)) {
    return { ok: false, error: "Use a deployment-scoped Convex key starting with dev: or prod:." };
  }
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"].convex.$put({
      json: { apiKey: trimmed },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not save the Convex API key."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save the Convex API key." };
  }
}
