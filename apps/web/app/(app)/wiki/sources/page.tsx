import { WikiSourcesPanel } from "@/components/WikiSourcesPanel";
import { currentUser } from "@/lib/auth";

export default async function WikiSourcesPage() {
  const { workspace, role } = await currentUser();

  return <WikiSourcesPanel workspaceId={workspace.id} isAdmin={role === "admin"} />;
}
