import type { ReactNode } from "react";
import { SiteFooter } from "./SiteFooter";
import { TopNav } from "./TopNav";

export function BlogShell({ children }: { children: ReactNode }) {
  return (
    <>
      <TopNav />
      <main>{children}</main>
      <SiteFooter />
    </>
  );
}
