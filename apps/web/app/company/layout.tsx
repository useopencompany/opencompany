import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { currentWorkspace } from "@/lib/auth";
import { isCompanySurfaceEnabled } from "@/lib/flags/companySurface";
import { isPersonalFirst } from "@/lib/flags/personalFirst";

// The legacy company/workspace surface. Company-first users get unconditional access (it is their
// primary surface); personal-first users only get in after opting in from personal Settings
// (users.companySurfaceEnabled). currentWorkspace() is request-memoized, so the extra call here is
// free for the pages below that load it anyway.
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { user } = await currentWorkspace();
  if (isPersonalFirst(user) && !isCompanySurfaceEnabled(user)) {
    redirect("/personal");
  }
  return <AppShell>{children}</AppShell>;
}
