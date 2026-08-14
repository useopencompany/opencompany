"use server";

import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiError } from "@/lib/server-api-client";

// Mirrors the protocol's UserPreferences contract with concrete web-side types:
// the generated z.infer types collapse to `any` under this app's tsconfig.
export type TaskViewMode = "board" | "list";

type UserPreferences = {
  timezone: string;
  taskSpawningEnabled: boolean;
  wikiEnabled: boolean;
  taskViewMode: TaskViewMode;
  imessageEnabled: boolean;
  autoModelRoutingEnabled: boolean;
};

export async function updateTimezoneAction(timezone: string) {
  const preferences = await patchPreferences({ timezone });
  return { ok: true, timezone: preferences.timezone } as const;
}

export async function updateTaskSpawningAction(enabled: boolean) {
  const preferences = await patchPreferences({ taskSpawningEnabled: enabled === true });
  revalidatePath("/");
  revalidatePath("/settings/preferences");
  return { ok: true, enabled: preferences.taskSpawningEnabled } as const;
}

export async function updateWikiEnabledAction(enabled: boolean) {
  const preferences = await patchPreferences({ wikiEnabled: enabled === true });
  revalidatePath("/");
  revalidatePath("/settings/preferences");
  revalidatePath("/wiki");
  return { ok: true, enabled: preferences.wikiEnabled } as const;
}

export async function updateTaskViewModeAction(mode: TaskViewMode) {
  // Callers use the result without a try/catch, so invalid modes and transport
  // failures both surface as ok: false instead of a thrown error.
  try {
    const preferences = await patchPreferences({ taskViewMode: mode });
    revalidatePath("/tasks");
    return { ok: true, mode: preferences.taskViewMode } as const;
  } catch {
    return { ok: false, mode } as const;
  }
}

export async function updateImessageEnabledAction(enabled: boolean) {
  const preferences = await patchPreferences({ imessageEnabled: enabled === true });
  revalidatePath("/");
  revalidatePath("/settings/preferences");
  revalidatePath("/settings/integrations");
  return { ok: true, enabled: preferences.imessageEnabled } as const;
}

export async function updateAutoModelRoutingAction(enabled: boolean) {
  const preferences = await patchPreferences({ autoModelRoutingEnabled: enabled === true });
  revalidatePath("/");
  revalidatePath("/settings/preferences");
  return { ok: true, enabled: preferences.autoModelRoutingEnabled } as const;
}

async function patchPreferences(body: Partial<UserPreferences>): Promise<UserPreferences> {
  const response = await (await serverApiClient()).v1.me.preferences.$patch({ json: body });
  if (!response.ok) {
    throw await serverApiError(response, "Preferences could not be saved.");
  }
  return (await response.json()).data;
}
