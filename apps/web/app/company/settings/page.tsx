import { getDb } from "@opencompany/db/client";
import { userAvatars } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import SettingsView from "@/components/SettingsView";
import { currentWorkspace } from "@/lib/auth";
import { loadBillingOverview } from "@/lib/billing/service";
import { loadWorkspaceMcpSettingsForWorkspace } from "@/lib/mcp/data";
import { loadWorkspaceToolPolicyOverrides } from "@/lib/tool-policies/data";
import { loadWorkspaceSyncStatus } from "@/lib/workspace-state/status";

function initialsFor(name: string, email: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  const last = parts.at(-1);
  if (first && last && parts.length >= 2) {
    return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
  }
  if (first) {
    return first.slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export default async function SettingsPage() {
  const { authUser, user, workspace } = await currentWorkspace();
  const db = getDb();
  const [syncStatus, [avatar], billing, mcp, toolPolicies] = await Promise.all([
    loadWorkspaceSyncStatus(db, workspace.id),
    db
      .select({ updatedAt: userAvatars.updatedAt })
      .from(userAvatars)
      .where(eq(userAvatars.userId, user.id))
      .limit(1),
    loadBillingOverview(workspace.id),
    loadWorkspaceMcpSettingsForWorkspace(workspace.id),
    loadWorkspaceToolPolicyOverrides(workspace.id),
  ]);
  const customAvatarUrl = avatar
    ? `/api/avatar/${user.id}?v=${new Date(avatar.updatedAt).getTime()}`
    : null;
  const displayName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim() ||
    authUser.email.split("@")[0] ||
    authUser.email;

  return (
    <SettingsView
      profile={{
        name: displayName,
        email: authUser.email,
        avatarUrl: customAvatarUrl ?? authUser.profilePictureUrl ?? null,
        hasCustomAvatar: Boolean(customAvatarUrl),
        initials: initialsFor(displayName, authUser.email),
      }}
      workspace={{
        name: workspace.name,
        createdAt: formatDate(new Date(workspace.createdAt)),
        sync: {
          hasRepo: syncStatus.hasRepo,
          lastSyncedAt: syncStatus.lastSyncedAt
            ? formatDate(new Date(syncStatus.lastSyncedAt))
            : null,
          pendingCount: syncStatus.pendingCount,
          failedCount: syncStatus.failedCount,
        },
      }}
      billing={{
        balanceUsdMicros: billing.balanceUsdMicros,
        spendLast7UsdMicros: billing.spendLast7UsdMicros,
        spendLast30UsdMicros: billing.spendLast30UsdMicros,
        dailySpend: billing.dailySpend,
        recentSessionCharges: billing.recentSessionCharges.map((entry) => ({
          ...entry,
          createdAt: entry.createdAt.toISOString(),
        })),
        ledger: billing.ledger.map((entry) => ({
          ...entry,
          createdAt: entry.createdAt.toISOString(),
        })),
      }}
      mcp={mcp}
      toolPolicies={toolPolicies}
    />
  );
}
