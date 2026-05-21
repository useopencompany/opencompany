import AppShell from "@/components/AppShell";
import SettingsView from "@/components/SettingsView";
import { getCurrentWorkspace } from "@/lib/auth";

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
  const { authUser, workspace } = await getCurrentWorkspace();
  const displayName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim() ||
    authUser.email.split("@")[0] ||
    authUser.email;

  return (
    <AppShell>
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
        }}
      />
    </AppShell>
  );
}
