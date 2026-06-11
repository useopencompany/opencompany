"use server";

import { centsToUsdMicros } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import { workspaceSpendLimits, workspaces } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { AUTHENTICATION_REQUIRED_MESSAGE, currentWorkspace } from "@/lib/auth";
import {
  isValidDailyCapCents,
  MAX_DAILY_CAP_CENTS,
  MIN_DAILY_CAP_CENTS,
} from "@/lib/billing/constants";
import { getWorkOSClient } from "@/lib/workos";

export async function updateWorkspaceName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false as const, error: "Name cannot be empty." };
  if (trimmed.length > 80) {
    return { ok: false as const, error: "Name is too long (max 80 chars)." };
  }

  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const { workspace } = context;
  if (!workspace.workosOrganizationId) {
    return { ok: false as const, error: "Workspace is not linked to an organization." };
  }

  const db = getDb();

  await getWorkOSClient().organizations.updateOrganization({
    organization: workspace.workosOrganizationId,
    name: trimmed,
  });

  await db
    .update(workspaces)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));

  revalidatePath("/", "layout");
  revalidatePath("/company/settings");

  return { ok: true as const, name: trimmed };
}

// Set or clear the workspace daily spend cap. Admin-only: `requireAdmin` throws for members, so
// authorization is enforced server-side regardless of what the UI shows. Passing `amountCents:
// null` disables the cap (unlimited) while keeping the row for audit; a positive amount enables it.
export async function setWorkspaceDailyCap(input: { amountCents: number | null }) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }
  if (context.role !== "admin") {
    return { ok: false as const, error: "Only workspace admins can change the spend cap." };
  }

  const { workspace, user } = context;
  const db = getDb();
  const now = new Date();

  if (input.amountCents === null) {
    await db
      .insert(workspaceSpendLimits)
      .values({
        workspaceId: workspace.id,
        dailyCapUsdMicros: null,
        enabled: false,
        updatedByUserId: user.id,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workspaceSpendLimits.workspaceId,
        set: { enabled: false, updatedByUserId: user.id, updatedAt: now },
      });
    revalidatePath("/settings");
    return { ok: true as const, capUsdMicros: null };
  }

  if (!isValidDailyCapCents(input.amountCents)) {
    return {
      ok: false as const,
      error: `Daily cap must be between $${MIN_DAILY_CAP_CENTS / 100} and $${(
        MAX_DAILY_CAP_CENTS / 100
      ).toLocaleString("en-US")}.`,
    };
  }

  const capUsdMicros = centsToUsdMicros(input.amountCents);
  await db
    .insert(workspaceSpendLimits)
    .values({
      workspaceId: workspace.id,
      dailyCapUsdMicros: capUsdMicros,
      enabled: true,
      updatedByUserId: user.id,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceSpendLimits.workspaceId,
      set: {
        dailyCapUsdMicros: capUsdMicros,
        enabled: true,
        updatedByUserId: user.id,
        updatedAt: now,
      },
    });

  revalidatePath("/settings");
  return { ok: true as const, capUsdMicros };
}
