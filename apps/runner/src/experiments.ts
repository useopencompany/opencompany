import { isExperimentKey, type WorkspaceExperiments } from "@opencompany/agent-runtime";
import { workspaceExperiments } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { getDb } from "./db";

// Load every workspace_experiments row for a workspace into the typed flag map the runtime config
// gates on. Unknown keys (left over from removed experiments) are ignored so a stale row can never
// flip a current flag. A workspace with no rows reads as every experiment off.
export async function loadWorkspaceExperiments(workspaceId: string): Promise<WorkspaceExperiments> {
  const rows = await getDb()
    .select({ key: workspaceExperiments.key, enabled: workspaceExperiments.enabled })
    .from(workspaceExperiments)
    .where(eq(workspaceExperiments.workspaceId, workspaceId));

  const experiments: WorkspaceExperiments = {};
  for (const row of rows) {
    if (isExperimentKey(row.key)) {
      experiments[row.key] = row.enabled;
    }
  }
  return experiments;
}
