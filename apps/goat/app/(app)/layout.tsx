import type { ReactNode } from "react";
import { GoatAppShell } from "@/components/GoatAppShell";
import { GoatShell } from "@/components/GoatShell";

export const dynamic = "force-dynamic";

export default function GoatInteractiveLayout({ children }: { children: ReactNode }) {
  return (
    <GoatAppShell>
      <GoatShell>{children}</GoatShell>
    </GoatAppShell>
  );
}
