import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { GoatAppShell } from "@/components/GoatAppShell";
import { GoatShell } from "@/components/GoatShell";
import { currentGoatUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function GoatInteractiveLayout({ children }: { children: ReactNode }) {
  // First-run gate: users who haven't finished onboarding are sent to it.
  // The /onboarding route lives outside this layout, so it never loops.
  const { user } = await currentGoatUser();
  if (!user.onboardedAt) redirect("/onboarding");

  return (
    <GoatAppShell>
      <GoatShell>{children}</GoatShell>
    </GoatAppShell>
  );
}
