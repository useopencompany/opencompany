import { GoatIntegrationsSettingsRoute } from "@/components/GoatRoutes";
import { browserProfilesAvailable } from "@/lib/browser-profiles";

export default function IntegrationsSettingsPage() {
  return <GoatIntegrationsSettingsRoute browserProfilesEnabled={browserProfilesAvailable()} />;
}
