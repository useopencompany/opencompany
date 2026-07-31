"use server";

import { normalizeScheduleTimezone } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { type GoatTaskViewMode, goatUsers } from "@opencompany/db/goat-schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { isGoatTaskViewMode } from "@/lib/task-display";

export async function updateGoatTimezoneAction(timezone: string) {
  const { user } = await currentGoatUser();
  const normalized = normalizeScheduleTimezone(timezone);
  if (normalized === user.timezone) return { ok: true, timezone: normalized } as const;

  const [updated] = await getDb()
    .update(goatUsers)
    .set({ timezone: normalized, updatedAt: new Date() })
    .where(eq(goatUsers.workosUserId, user.workosUserId))
    .returning({ timezone: goatUsers.timezone });

  return { ok: Boolean(updated), timezone: updated?.timezone ?? user.timezone } as const;
}

export async function updateGoatTaskSpawningAction(enabled: boolean) {
  const { user } = await currentGoatUser();
  const nextEnabled = enabled === true;
  if (nextEnabled === user.taskSpawningEnabled) {
    return { ok: true, enabled: nextEnabled } as const;
  }

  const [updated] = await getDb()
    .update(goatUsers)
    .set({ taskSpawningEnabled: nextEnabled, updatedAt: new Date() })
    .where(eq(goatUsers.workosUserId, user.workosUserId))
    .returning({ taskSpawningEnabled: goatUsers.taskSpawningEnabled });

  revalidatePath("/");
  revalidatePath("/settings/preferences");
  return {
    ok: Boolean(updated),
    enabled: updated?.taskSpawningEnabled ?? user.taskSpawningEnabled,
  } as const;
}

export async function updateGoatTaskViewModeAction(mode: GoatTaskViewMode) {
  const { user } = await currentGoatUser();
  if (!isGoatTaskViewMode(mode)) return { ok: false, mode: user.taskViewMode } as const;
  if (mode === user.taskViewMode) return { ok: true, mode } as const;

  const [updated] = await getDb()
    .update(goatUsers)
    .set({ taskViewMode: mode, updatedAt: new Date() })
    .where(eq(goatUsers.workosUserId, user.workosUserId))
    .returning({ taskViewMode: goatUsers.taskViewMode });

  revalidatePath("/tasks");
  return { ok: Boolean(updated), mode: updated?.taskViewMode ?? user.taskViewMode } as const;
}

export async function updateGoatImessageEnabledAction(enabled: boolean) {
  const { user } = await currentGoatUser();
  const nextEnabled = enabled === true;
  if (nextEnabled === user.imessageEnabled) {
    return { ok: true, enabled: nextEnabled } as const;
  }

  const [updated] = await getDb()
    .update(goatUsers)
    .set({ imessageEnabled: nextEnabled, updatedAt: new Date() })
    .where(eq(goatUsers.workosUserId, user.workosUserId))
    .returning({ imessageEnabled: goatUsers.imessageEnabled });

  revalidatePath("/");
  revalidatePath("/settings/preferences");
  revalidatePath("/settings/integrations");
  return {
    ok: Boolean(updated),
    enabled: updated?.imessageEnabled ?? user.imessageEnabled,
  } as const;
}

export async function updateGoatAutoModelRoutingAction(enabled: boolean) {
  const { user } = await currentGoatUser();
  const nextEnabled = enabled === true;
  if (nextEnabled === user.autoModelRoutingEnabled) {
    return { ok: true, enabled: nextEnabled } as const;
  }

  const [updated] = await getDb()
    .update(goatUsers)
    .set({ autoModelRoutingEnabled: nextEnabled, updatedAt: new Date() })
    .where(eq(goatUsers.workosUserId, user.workosUserId))
    .returning({ autoModelRoutingEnabled: goatUsers.autoModelRoutingEnabled });

  revalidatePath("/");
  revalidatePath("/settings/preferences");
  return {
    ok: Boolean(updated),
    enabled: updated?.autoModelRoutingEnabled ?? user.autoModelRoutingEnabled,
  } as const;
}
