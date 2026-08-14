import { WorkspaceSettingsPanel } from "@/components/WorkspaceSettingsPanel";
import { getWorkspaceSettingsAction } from "@/lib/workspace-actions";

export default async function WorkspaceSettingsPage() {
  const settings = await getWorkspaceSettingsAction();
  return <WorkspaceSettingsPanel initial={settings} />;
}
