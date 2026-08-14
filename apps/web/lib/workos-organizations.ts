import {
  ensureWorkspaceOrganizationsForEntries as ensureWorkspaceOrganizationsForEntriesWithClient,
  ensureWorkspaceOrganization as ensureWorkspaceOrganizationWithClient,
  type Workspace,
} from "@opencompany/agent/workspaces/organizations";
import { getWorkOSClient } from "@/lib/workos-client";

export function ensureWorkspaceOrganization(workspace: Workspace): Promise<string> {
  return ensureWorkspaceOrganizationWithClient(workspace, { workos: getWorkOSClient() });
}

export function ensureWorkspaceOrganizationsForEntries<T extends { workspace: Workspace }>(
  entries: T[],
): Promise<T[]> {
  return ensureWorkspaceOrganizationsForEntriesWithClient(entries, {
    workos: getWorkOSClient(),
  });
}
