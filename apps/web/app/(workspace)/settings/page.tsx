import { getDb } from "@opencompany/db/client";
import { workspaceRepositories } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import SettingsView from "@/components/SettingsView";
import { requireCurrentWorkspace } from "@/lib/auth";
import { loadBillingOverview } from "@/lib/billing/service";

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
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export default async function SettingsPage() {
  const { authUser, workspace } = await requireCurrentWorkspace();
  const db = getDb();
  const [[repository], billing] = await Promise.all([
    db
      .select({
        updatedAt: workspaceRepositories.updatedAt,
      })
      .from(workspaceRepositories)
      .where(eq(workspaceRepositories.workspaceId, workspace.id))
      .limit(1),
    loadBillingOverview(workspace.id),
  ]);
  const displayName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim() ||
    authUser.email.split("@")[0] ||
    authUser.email;

  return (
    <SettingsView
      profile={{
        name: displayName,
        email: authUser.email,
        avatarUrl: authUser.profilePictureUrl ?? null,
        initials: initialsFor(displayName, authUser.email),
      }}
      workspace={{
        name: workspace.name,
        createdAt: formatDate(new Date(workspace.createdAt)),
        repository: repository
          ? {
              updatedAt: formatDate(new Date(repository.updatedAt)),
            }
          : null,
      }}
      billing={{
        balanceUsdMicros: billing.balanceUsdMicros,
        spendLast7UsdMicros: billing.spendLast7UsdMicros,
        spendLast30UsdMicros: billing.spendLast30UsdMicros,
        recentSessionCharges: billing.recentSessionCharges.map((entry) => ({
          ...entry,
          createdAt: entry.createdAt.toISOString(),
        })),
        ledger: billing.ledger.map((entry) => ({
          ...entry,
          createdAt: entry.createdAt.toISOString(),
        })),
      }}
    />
  );
}
