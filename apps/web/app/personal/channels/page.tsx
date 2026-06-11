import { PersonalChannelsPanel } from "@/components/personal/PersonalChannelsPanel";
import { currentWorkspace } from "@/lib/auth";
import { loadWhatsAppChannelState } from "@/lib/personal/channels";

// Self-contained server component: loads channel state only on this route (not on every /personal
// page) and hands it to the client panel.
export default async function PersonalChannelsPage() {
  const { user, workspace } = await currentWorkspace();
  const whatsapp = await loadWhatsAppChannelState({ userId: user.id, workspaceId: workspace.id });

  return (
    <div className="h-full overflow-y-auto">
      <PersonalChannelsPanel whatsapp={whatsapp} />
    </div>
  );
}
