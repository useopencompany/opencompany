import { WorkspaceSettingsPanel } from "@/components/WorkspaceSettingsPanel";
import { getGoatWorkspaceSettingsAction } from "@/lib/workspace-actions";

export default async function WorkspaceSettingsPage() {
  const settings = await getGoatWorkspaceSettingsAction();
  return <WorkspaceSettingsPanel initial={settings} />;
}
