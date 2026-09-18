"use server";

import { revalidatePath } from "next/cache";
import type { PostHogEventsProviderState } from "@/lib/integration-state";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type PostHogEventsConnectResult =
  | { ok: true; state: PostHogEventsProviderState }
  | { ok: false; error: string };

export async function savePostHogEventsConnectionAction(input: {
  apiKey: string;
  projectId: string;
  region: "us" | "eu";
}): Promise<PostHogEventsConnectResult> {
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"][
      "posthog-events"
    ].$put({ json: input });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not connect PostHog events."),
      };
    }
    const data = (await response.json()).data as { state: PostHogEventsProviderState };
    revalidatePath("/", "layout");
    return { ok: true, state: data.state };
  } catch (error) {
    console.error("[opencompany-posthog-events] Failed to save connection", error);
    return { ok: false, error: "Could not connect PostHog events." };
  }
}

export type PostHogEventDefinitionListResult =
  | { ok: true; events: Array<{ id: string; name: string }>; partial: boolean }
  | { ok: false; error: string };

export async function listPostHogEventDefinitionsAction(
  integrationId: string,
): Promise<PostHogEventDefinitionListResult> {
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"]["posthog-events"][
      ":integrationId"
    ].events.$get({
      param: { integrationId },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not load PostHog events."),
      };
    }
    return { ok: true, ...(await response.json()).data };
  } catch (error) {
    console.error("[opencompany-posthog-events] Failed to list event definitions", error);
    return { ok: false, error: "Could not load PostHog events." };
  }
}
