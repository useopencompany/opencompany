"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { ConvexEventsProviderState } from "@/lib/integration-state";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type ConvexEventsActionResult =
  | { ok: true; state: ConvexEventsProviderState }
  | { ok: false; error: string };

// Convex's own refusals are specific — a missing deploy-key permission, a team below Pro, a
// webhook log stream already pointed somewhere else — so the API's message is what the user sees.
export async function enableConvexErrorEventsAction(): Promise<ConvexEventsActionResult> {
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"][
      "convex-events"
    ].$post({}, { headers: { "idempotency-key": randomUUID() } });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not turn on Convex error events."),
      };
    }
    const data = (await response.json()).data as { state: ConvexEventsProviderState };
    revalidatePath("/", "layout");
    return { ok: true, state: data.state };
  } catch (error) {
    console.error("[opencompany-convex] Failed to turn on Convex error events", error);
    return { ok: false, error: "Could not turn on Convex error events." };
  }
}

export async function disableConvexErrorEventsAction(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"][
      "convex-events"
    ].$delete();
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not turn off Convex error events."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    console.error("[opencompany-convex] Failed to turn off Convex error events", error);
    return { ok: false, error: "Could not turn off Convex error events." };
  }
}
