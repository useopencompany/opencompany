import "server-only";

import type { ProjectDto } from "@opencompany/protocol";
import { serverApiClient, serverApiError } from "@/lib/server-api-client";

/**
 * Name of a sidebar Project the reader owns, or null when Projects are disabled for them or the id
 * is unknown. The home route uses it to title the project's new-chat screen without trusting the
 * name to the query string.
 */
export async function loadProjectName(
  projectId: string | null | undefined,
): Promise<string | null> {
  const trimmed = projectId?.trim();
  if (!trimmed) return null;

  const client = await serverApiClient();
  const response = await client.v1.projects.$get();
  // Projects are gated per reader, and the list 404s when the flag is off.
  if (response.status === 404) return null;
  if (!response.ok) throw await serverApiError(response, "Could not load your projects.");

  const projects: ProjectDto[] = (await response.json()).data;
  return projects.find((project) => project.id === trimmed)?.name ?? null;
}
