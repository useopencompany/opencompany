import type { LucideIcon } from "lucide-react";
import { ArrowLeft, CircleUserRound, Mail, UserRound } from "lucide-react";
import Link from "next/link";
import { SettingsIntegrationsPanel } from "@/components/SettingsIntegrationsPanel";
import { currentGoatUser } from "@/lib/auth";
import { getGoatGitHubIntegrationState } from "@/lib/integrations/github";
import { getGoatGoogleIntegrationState } from "@/lib/integrations/google-data";
import { getGoatLinearIntegrationState } from "@/lib/integrations/linear-mcp";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { authUser, user } = await currentGoatUser();
  const [googleIntegrations, linear, github] = await Promise.all([
    getGoatGoogleIntegrationState(user.workosUserId),
    getGoatLinearIntegrationState(user.workosUserId),
    getGoatGitHubIntegrationState(user.workosUserId),
  ]);
  const integrations = { ...googleIntegrations, linear, github };
  const name = [authUser.firstName, authUser.lastName].filter(Boolean).join(" ").trim();
  const displayName = name || user.email;
  const initials = getInitials(authUser.firstName, authUser.lastName, user.email);

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[560px] flex-col gap-8 pb-24 pt-16 sm:pt-24">
          <Link
            href="/"
            className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <ArrowLeft size={14} strokeWidth={2} />
            Goat
          </Link>

          <header className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              {user.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="h-12 w-12 rounded-full bg-surface-muted object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-[15px] font-semibold text-ink">
                  {initials}
                </div>
              )}
              <div className="min-w-0">
                <h1 className="truncate text-[34px] font-semibold leading-tight tracking-normal text-ink">
                  Settings
                </h1>
                <p className="truncate text-[13px] leading-5 text-ink-subtle">{displayName}</p>
              </div>
            </div>
          </header>

          <section className="flex flex-col gap-1">
            <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Account
            </h2>
            <AccountRow icon={Mail} label="Email" value={user.email} />
            <AccountRow icon={UserRound} label="Name" value={name || "Not set"} />
            <AccountRow
              icon={CircleUserRound}
              label="First name"
              value={authUser.firstName?.trim() || "Not set"}
            />
            <AccountRow
              icon={CircleUserRound}
              label="Last name"
              value={authUser.lastName?.trim() || "Not set"}
            />
          </section>

          <section className="flex flex-col gap-1">
            <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
              Personal integrations
            </h2>
            <SettingsIntegrationsPanel initialIntegrations={integrations} />
          </section>
        </div>
      </div>
    </main>
  );
}

function AccountRow({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2">
      <Icon size={16} strokeWidth={2} className="shrink-0 text-ink-subtle" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="w-20 shrink-0 text-[12.5px] leading-tight text-ink-subtle">{label}</span>
        <span className="truncate text-[14px] font-medium leading-tight text-ink">{value}</span>
      </div>
    </div>
  );
}

function getInitials(firstName: string | null, lastName: string | null, email: string) {
  const initials = [firstName, lastName]
    .map((part) => part?.trim().at(0))
    .filter(Boolean)
    .join("")
    .toUpperCase();

  return initials || email.trim().at(0)?.toUpperCase() || "?";
}
