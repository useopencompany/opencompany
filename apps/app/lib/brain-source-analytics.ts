import { captureServerEvent } from "@opencompany/analytics/server";
import { upsertBrainSource } from "@opencompany/db/brain-sources";

type UpsertBrainSourceInput = Parameters<typeof upsertBrainSource>[0];

export async function upsertBrainSourceWithAnalytics(
  input: UpsertBrainSourceInput & { workspaceId: string },
) {
  const { workspaceId, ...sourceInput } = input;
  const result = await upsertBrainSource(sourceInput);

  if (result.created && sourceInput.enabled) {
    await captureServerEvent("brain_source_added", sourceInput.createdByWorkosId, {
      workspace_id: workspaceId,
      brain_id: sourceInput.brainRef,
      provider: sourceInput.provider,
    });
  }

  return result;
}
