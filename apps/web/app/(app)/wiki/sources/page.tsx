import { notFound } from "next/navigation";
import { WikiSourcesPanel } from "@/components/WikiSourcesPanel";
import { currentUser } from "@/lib/auth";

export default async function WikiSourcesPage() {
  const { user, workspace, role } = await currentUser();
  if (!user.wikiEnabled) notFound();

  return <WikiSourcesPanel workspaceId={workspace.id} isAdmin={role === "admin"} />;
}
