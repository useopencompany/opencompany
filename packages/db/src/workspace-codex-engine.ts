import { and, eq } from "drizzle-orm";
import { getDb } from "./client";
import {
  codexCredentials,
  users,
  workspaceCodexEngineAccounts,
  workspaceMembers,
} from "./product-schema";

type DbLike = any;

export type WorkspaceCodexEngineAccountState = {
  enabled: boolean;
  providerUserWorkosId: string;
  providerEmail: string;
  providerName: string | null;
  credentialStatus: "connected" | "needs_reauth";
  credentialStatusReason: string | null;
  updatedAt: Date;
};

export async function loadWorkspaceCodexEngineAccount(input: {
  workspaceId: string;
  db?: DbLike;
}): Promise<WorkspaceCodexEngineAccountState | null> {
  const db = input.db ?? getDb();
  const [row] = await db
    .select({
      enabled: workspaceCodexEngineAccounts.enabled,
      providerUserWorkosId: workspaceCodexEngineAccounts.providerUserWorkosId,
      providerEmail: users.email,
      providerFirstName: users.firstName,
      providerLastName: users.lastName,
      credentialStatus: codexCredentials.status,
      credentialStatusReason: codexCredentials.statusReason,
      updatedAt: workspaceCodexEngineAccounts.updatedAt,
    })
    .from(workspaceCodexEngineAccounts)
    .innerJoin(
      codexCredentials,
      eq(codexCredentials.userWorkosId, workspaceCodexEngineAccounts.providerUserWorkosId),
    )
    .innerJoin(users, eq(users.workosUserId, workspaceCodexEngineAccounts.providerUserWorkosId))
    .where(eq(workspaceCodexEngineAccounts.workspaceId, input.workspaceId))
    .limit(1);
  if (!row) return null;
  const providerName = [row.providerFirstName, row.providerLastName].filter(Boolean).join(" ");
  return {
    enabled: row.enabled,
    providerUserWorkosId: row.providerUserWorkosId,
    providerEmail: row.providerEmail,
    providerName: providerName || null,
    credentialStatus: row.credentialStatus,
    credentialStatusReason: row.credentialStatusReason,
    updatedAt: row.updatedAt,
  };
}

export async function designateWorkspaceCodexEngineAccount(input: {
  workspaceId: string;
  providerUserWorkosId: string;
  db?: DbLike;
  now?: Date;
}) {
  const db = input.db ?? getDb();
  const [eligibility] = await db
    .select({ status: codexCredentials.status })
    .from(workspaceMembers)
    .innerJoin(codexCredentials, eq(codexCredentials.userWorkosId, workspaceMembers.userWorkosId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, input.workspaceId),
        eq(workspaceMembers.userWorkosId, input.providerUserWorkosId),
        eq(workspaceMembers.role, "admin"),
      ),
    )
    .limit(1);
  if (!eligibility) return { ok: false as const, reason: "admin_required" as const };
  if (eligibility.status !== "connected") {
    return { ok: false as const, reason: "codex_reauth_required" as const };
  }

  const now = input.now ?? new Date();
  const [account] = await db
    .insert(workspaceCodexEngineAccounts)
    .values({
      workspaceId: input.workspaceId,
      providerUserWorkosId: input.providerUserWorkosId,
      designatedByWorkosId: input.providerUserWorkosId,
      enabled: true,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceCodexEngineAccounts.workspaceId,
      set: {
        providerUserWorkosId: input.providerUserWorkosId,
        designatedByWorkosId: input.providerUserWorkosId,
        enabled: true,
        updatedAt: now,
      },
    })
    .returning({ workspaceId: workspaceCodexEngineAccounts.workspaceId });
  if (!account) throw new Error("Could not designate the workspace Codex engine account.");
  return { ok: true as const };
}

export async function clearWorkspaceCodexEngineAccount(input: {
  workspaceId: string;
  requestedByWorkosId: string;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const [admin] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, input.workspaceId),
        eq(workspaceMembers.userWorkosId, input.requestedByWorkosId),
        eq(workspaceMembers.role, "admin"),
      ),
    )
    .limit(1);
  if (!admin) return { ok: false as const, reason: "admin_required" as const };
  await db
    .delete(workspaceCodexEngineAccounts)
    .where(eq(workspaceCodexEngineAccounts.workspaceId, input.workspaceId));
  return { ok: true as const };
}
