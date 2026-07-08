import type { ReactNode } from "react";
import { GoatAppShell } from "@/components/GoatAppShell";

export const dynamic = "force-dynamic";

export default function GoatInteractiveLayout({ children }: { children: ReactNode }) {
  return <GoatAppShell>{children}</GoatAppShell>;
}
