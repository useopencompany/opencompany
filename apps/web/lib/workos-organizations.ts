import {
  ensureGoatWorkspaceOrganizationsForEntries as ensureGoatWorkspaceOrganizationsForEntriesWithClient,
  ensureGoatWorkspaceOrganization as ensureGoatWorkspaceOrganizationWithClient,
  type GoatWorkspace,
} from "@opencompany/goat-agent/workspaces/organizations";
import { getWorkOSClient } from "@/lib/workos-client";

export function ensureGoatWorkspaceOrganization(workspace: GoatWorkspace): Promise<string> {
  return ensureGoatWorkspaceOrganizationWithClient(workspace, { workos: getWorkOSClient() });
}

export function ensureGoatWorkspaceOrganizationsForEntries<T extends { workspace: GoatWorkspace }>(
  entries: T[],
): Promise<T[]> {
  return ensureGoatWorkspaceOrganizationsForEntriesWithClient(entries, {
    workos: getWorkOSClient(),
  });
}
