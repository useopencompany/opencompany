import type { Actor } from "@opencompany/core";
import { and, eq, or, sql } from "drizzle-orm";
import { skillBundles, skillInstallations, skillScopeRollout } from "./product-schema";

export type SkillReader = { workspaceId: string; userId?: string; skillAccess?: "company" };

export async function personalSkillsEnabled(db: any): Promise<boolean> {
  const [rollout] = await db
    .select({ enabled: skillScopeRollout.personalEnabled })
    .from(skillScopeRollout)
    .where(eq(skillScopeRollout.id, "personal_skills"))
    .limit(1);
  return rollout?.enabled === true;
}

export function skillMembership(input: SkillReader, admin = false) {
  return input.userId
    ? sql`EXISTS (SELECT 1 FROM goat.workspace_members member WHERE member.workspace_id = ${input.workspaceId} AND member.user_workos_id = ${input.userId} ${admin ? sql`AND member.role = 'admin'` : sql``})`
    : sql`false`;
}

export function skillInstallationAccess(input: SkillReader) {
  return and(
    eq(skillInstallations.workspaceId, input.workspaceId),
    input.userId ? skillMembership(input) : undefined,
    or(
      eq(skillInstallations.scope, "company"),
      input.userId && input.skillAccess !== "company"
        ? eq(skillInstallations.createdByUserId, input.userId)
        : undefined,
    ),
  )!;
}

export function skillManagementPermission(actor: Actor) {
  return sql<boolean>`coalesce(${and(skillInstallationAccess(actor), or(eq(skillInstallations.createdByUserId, actor.userId), skillMembership(actor, true)))}, false)`;
}

// A pinned Chat keeps what its owner already received. Arbitrary bundle IDs never grant access.
// Workflows omit a personal reader and can only load company or plugin revisions.
export function skillBundleAccess(input: SkillReader & { chatSessionId?: string }) {
  return and(
    eq(skillBundles.workspaceId, input.workspaceId),
    input.userId ? skillMembership(input) : undefined,
    sql`(
      EXISTS (
        SELECT 1 FROM goat.skill_installation_versions version
        JOIN goat.skill_installations installation ON installation.id = version.installation_id
        WHERE version.bundle_id = ${skillBundles.id}
          AND installation.workspace_id = ${input.workspaceId}
          AND ((installation.scope = 'company' AND version.company_shared) ${input.userId && input.skillAccess !== "company" ? sql`OR installation.created_by_user_id = ${input.userId}` : sql``})
      ) OR EXISTS (
        SELECT 1 FROM goat.plugin_skills skill
        JOIN goat.plugins plugin ON plugin.id = skill.plugin_id AND plugin.workspace_id = skill.workspace_id
        WHERE skill.skill_bundle_id = ${skillBundles.id} AND skill.workspace_id = ${input.workspaceId}
          AND plugin.status = 'enabled'
          AND ${input.userId ? sql`plugin.owner_user_id = ${input.userId}` : sql`false`}
      ) ${
        input.userId && input.chatSessionId && input.skillAccess !== "company"
          ? sql`OR EXISTS (
        SELECT 1 FROM goat.chat_session_skill_bundles snapshot
        JOIN goat.chat_sessions session ON session.id = snapshot.chat_session_id
        WHERE snapshot.bundle_id = ${skillBundles.id} AND session.id = ${input.chatSessionId}
          AND session.user_workos_id = ${input.userId}
          AND snapshot.source_kind = 'standalone'
      )`
          : sql``
      }
    )`,
  )!;
}

export function conflictingChatSkillNames(chatSessionId: string, bundleIds: readonly string[]) {
  if (bundleIds.length === 0) return sql`false`;
  return sql`EXISTS (
    SELECT 1 FROM goat.chat_session_skill_bundles snapshot
    JOIN goat.skill_bundles selected ON selected.name = snapshot.name
    WHERE snapshot.chat_session_id = ${chatSessionId}
      AND selected.id IN (${sql.join(
        bundleIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND selected.id <> snapshot.bundle_id
      AND NOT EXISTS (
        SELECT 1 FROM goat.skill_installation_versions previous
        JOIN goat.skill_installation_versions next ON next.installation_id = previous.installation_id
        WHERE previous.bundle_id = snapshot.bundle_id AND next.bundle_id = selected.id
      )
  )`;
}

// ON CONFLICT locks the winning snapshot, including a concurrent insert invisible to an earlier
// read. Keep revisions of the same installation pinned; a different Skill deliberately fails the
// bundle_id NOT NULL constraint so the entire activation/message transaction rolls back.
export function preserveChatSkillBundle() {
  return sql`CASE
    WHEN goat.chat_session_skill_bundles.bundle_id = excluded.bundle_id
      OR EXISTS (
        SELECT 1 FROM goat.skill_installation_versions previous
        JOIN goat.skill_installation_versions next ON next.installation_id = previous.installation_id
        WHERE previous.bundle_id = goat.chat_session_skill_bundles.bundle_id
          AND next.bundle_id = excluded.bundle_id
      )
    THEN goat.chat_session_skill_bundles.bundle_id
    ELSE NULL
  END`;
}

export function isChatSkillNameConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; table?: string; column?: string; cause?: unknown };
  return (
    (value.code === "23502" &&
      value.table === "chat_session_skill_bundles" &&
      value.column === "bundle_id") ||
    isChatSkillNameConflict(value.cause)
  );
}
