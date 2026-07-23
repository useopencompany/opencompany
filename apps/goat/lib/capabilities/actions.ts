"use server";

import {
  GOAT_MANAGED_CAPABILITY_SOURCES,
  setGoatWorkspaceCapability,
} from "@opencompany/db/goat-capabilities";
import type { GoatManagedCapabilitySource } from "@opencompany/db/goat-schema";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";

export async function setWorkspaceCapabilityAction(input: {
  source: GoatManagedCapabilitySource;
  enabled: boolean;
}) {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return {
      ok: false as const,
      error: "Only workspace admins can change paid capabilities.",
    };
  }
  if (
    !input ||
    typeof input.enabled !== "boolean" ||
    !GOAT_MANAGED_CAPABILITY_SOURCES.includes(input.source)
  ) {
    return { ok: false as const, error: "Invalid capability setting." };
  }
  const row = await setGoatWorkspaceCapability({
    workspaceId: context.workspace.id,
    source: input.source,
    enabled: input.enabled,
    updatedByWorkosId: context.user.workosUserId,
  });
  revalidatePath("/settings/workspace/capabilities");
  return { ok: true as const, source: row.source, enabled: row.enabled };
}
