"use server";

import { getDb } from "@opencompany/db/client";
import { workspaceIntegrations, workspaceKpis } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentWorkspace } from "@/lib/auth";
import { triggerKpiEvaluation } from "@/lib/kpis/events";
import { getKpiTemplate, normalizeKpiFilterParams } from "@/lib/kpis/templates";

export async function createKpiAction(formData: FormData): Promise<void> {
  const { workspace, user } = await currentWorkspace();
  const sourceIntegrationId = readFormString(formData.get("sourceIntegrationId"));
  const provider = readFormString(formData.get("provider")) || "posthog";
  const templateId = readFormString(formData.get("templateId"));
  const displayName = readFormString(formData.get("displayName"));
  const timeGrain = readFormString(formData.get("timeGrain"));

  if (!sourceIntegrationId) return;
  const template = getKpiTemplate(provider, templateId);
  if (!template) return;
  if (timeGrain !== "day" && timeGrain !== "week") {
    return;
  }
  if (!template.timeGrainOptions.includes(timeGrain)) {
    return;
  }

  const db = getDb();
  const [source] = await db
    .select({ id: workspaceIntegrations.id })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspace.id),
        eq(workspaceIntegrations.id, sourceIntegrationId),
        eq(workspaceIntegrations.provider, provider),
        eq(workspaceIntegrations.providerKind, "data_source"),
        eq(workspaceIntegrations.status, "connected"),
      ),
    )
    .limit(1);
  if (!source) return;

  const filterValues: Record<string, unknown> = {};
  for (const field of template.filterParamsSchema) {
    filterValues[field.id] = readFormString(formData.get(`filter.${field.id}`));
  }

  const now = new Date();
  const kpiId = newWorkspaceKpiId();
  await db.insert(workspaceKpis).values({
    id: kpiId,
    workspaceId: workspace.id,
    sourceIntegrationId,
    provider,
    templateId: template.id,
    displayName: displayName || template.displayName,
    timeGrain,
    filterParams: normalizeKpiFilterParams(template, filterValues),
    status: "active",
    statusReason: null,
    createdByUserId: user.id,
    updatedAt: now,
  });

  await triggerKpiEvaluation({ workspaceId: workspace.id, kpiId });
  revalidatePath("/company/kpis");
}

function readFormString(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function newWorkspaceKpiId() {
  return `wkpi_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
