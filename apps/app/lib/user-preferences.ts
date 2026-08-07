"use server";

import { normalizeScheduleTimezone } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { type TaskViewMode, users } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { isTaskViewMode } from "@/lib/task-display";

export async function updateTimezoneAction(timezone: string) {
  const { user } = await currentUser();
  const normalized = normalizeScheduleTimezone(timezone);
  if (normalized === user.timezone) return { ok: true, timezone: normalized } as const;

  const [updated] = await getDb()
    .update(users)
    .set({ timezone: normalized, updatedAt: new Date() })
    .where(eq(users.workosUserId, user.workosUserId))
    .returning({ timezone: users.timezone });

  return { ok: Boolean(updated), timezone: updated?.timezone ?? user.timezone } as const;
}

export async function updateTaskSpawningAction(enabled: boolean) {
  const { user } = await currentUser();
  const nextEnabled = enabled === true;
  if (nextEnabled === user.taskSpawningEnabled) {
    return { ok: true, enabled: nextEnabled } as const;
  }

  const [updated] = await getDb()
    .update(users)
    .set({ taskSpawningEnabled: nextEnabled, updatedAt: new Date() })
    .where(eq(users.workosUserId, user.workosUserId))
    .returning({ taskSpawningEnabled: users.taskSpawningEnabled });

  revalidatePath("/");
  revalidatePath("/settings/preferences");
  return {
    ok: Boolean(updated),
    enabled: updated?.taskSpawningEnabled ?? user.taskSpawningEnabled,
  } as const;
}

export async function updateTaskViewModeAction(mode: TaskViewMode) {
  const { user } = await currentUser();
  if (!isTaskViewMode(mode)) return { ok: false, mode: user.taskViewMode } as const;
  if (mode === user.taskViewMode) return { ok: true, mode } as const;

  const [updated] = await getDb()
    .update(users)
    .set({ taskViewMode: mode, updatedAt: new Date() })
    .where(eq(users.workosUserId, user.workosUserId))
    .returning({ taskViewMode: users.taskViewMode });

  revalidatePath("/tasks");
  return { ok: Boolean(updated), mode: updated?.taskViewMode ?? user.taskViewMode } as const;
}

export async function updateImessageEnabledAction(enabled: boolean) {
  const { user } = await currentUser();
  const nextEnabled = enabled === true;
  if (nextEnabled === user.imessageEnabled) {
    return { ok: true, enabled: nextEnabled } as const;
  }

  const [updated] = await getDb()
    .update(users)
    .set({ imessageEnabled: nextEnabled, updatedAt: new Date() })
    .where(eq(users.workosUserId, user.workosUserId))
    .returning({ imessageEnabled: users.imessageEnabled });

  revalidatePath("/");
  revalidatePath("/settings/preferences");
  revalidatePath("/settings/integrations");
  return {
    ok: Boolean(updated),
    enabled: updated?.imessageEnabled ?? user.imessageEnabled,
  } as const;
}

export async function updateAutoModelRoutingAction(enabled: boolean) {
  const { user } = await currentUser();
  const nextEnabled = enabled === true;
  if (nextEnabled === user.autoModelRoutingEnabled) {
    return { ok: true, enabled: nextEnabled } as const;
  }

  const [updated] = await getDb()
    .update(users)
    .set({ autoModelRoutingEnabled: nextEnabled, updatedAt: new Date() })
    .where(eq(users.workosUserId, user.workosUserId))
    .returning({ autoModelRoutingEnabled: users.autoModelRoutingEnabled });

  revalidatePath("/");
  revalidatePath("/settings/preferences");
  return {
    ok: Boolean(updated),
    enabled: updated?.autoModelRoutingEnabled ?? user.autoModelRoutingEnabled,
  } as const;
}
