import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import { upsertGoatBrainSource } from "@opencompany/db/brain-sources";

type UpsertGoatBrainSourceInput = Parameters<typeof upsertGoatBrainSource>[0];

export async function upsertGoatBrainSourceWithAnalytics(
  input: UpsertGoatBrainSourceInput & { workspaceId: string },
) {
  const { workspaceId, ...sourceInput } = input;
  const result = await upsertGoatBrainSource(sourceInput);

  if (result.created && sourceInput.enabled) {
    await captureGoatServerEvent("brain_source_added", sourceInput.createdByWorkosId, {
      workspace_id: workspaceId,
      brain_id: sourceInput.brainRef,
      provider: sourceInput.provider,
    });
  }

  return result;
}
