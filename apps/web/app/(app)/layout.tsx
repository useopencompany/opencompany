import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { Shell } from "@/components/Shell";
import { currentUser } from "@/lib/auth";
import { isDesktopRequest } from "@/lib/desktop";

export const dynamic = "force-dynamic";

export default async function InteractiveLayout({ children }: { children: ReactNode }) {
  // First-run gate: users who haven't finished onboarding are sent to it.
  // The /onboarding route lives outside this layout, so it never loops.
  const [{ user }, desktop] = await Promise.all([currentUser(), isDesktopRequest()]);
  if (!user.onboardedAt) redirect("/onboarding");

  return (
    <AppShell>
      <Shell desktopApp={desktop}>{children}</Shell>
    </AppShell>
  );
}
