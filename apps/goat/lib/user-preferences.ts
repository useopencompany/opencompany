"use server";

import { normalizeScheduleTimezone } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { goatUsers } from "@opencompany/db/goat-schema";
import { eq } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";

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
