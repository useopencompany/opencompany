import { getDb } from "@opencompany/db/client";
import { users, workspaceCodexCredentials } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";

export type WorkspaceCodexAuthSettings = {
  configured: boolean;
  status: "connected" | "needs_reauth" | null;
  statusReason: string | null;
  connectedByEmail: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
  updatedAt: string | null;
};

export async function loadWorkspaceCodexAuthSettings(
  workspaceId: string,
): Promise<WorkspaceCodexAuthSettings> {
  const [credential] = await getDb()
    .select({
      status: workspaceCodexCredentials.status,
      statusReason: workspaceCodexCredentials.statusReason,
      connectedByEmail: users.email,
      lastValidatedAt: workspaceCodexCredentials.lastValidatedAt,
      lastRotatedAt: workspaceCodexCredentials.lastRotatedAt,
      updatedAt: workspaceCodexCredentials.updatedAt,
    })
    .from(workspaceCodexCredentials)
    .leftJoin(users, eq(users.id, workspaceCodexCredentials.connectedByUserId))
    .where(eq(workspaceCodexCredentials.workspaceId, workspaceId))
    .limit(1);

  if (!credential) {
    return {
      configured: false,
      status: null,
      statusReason: null,
      connectedByEmail: null,
      lastValidatedAt: null,
      lastRotatedAt: null,
      updatedAt: null,
    };
  }

  return {
    configured: credential.status === "connected",
    status: credential.status,
    statusReason: credential.statusReason,
    connectedByEmail: credential.connectedByEmail,
    lastValidatedAt: credential.lastValidatedAt?.toISOString() ?? null,
    lastRotatedAt: credential.lastRotatedAt?.toISOString() ?? null,
    updatedAt: credential.updatedAt.toISOString(),
  };
}
