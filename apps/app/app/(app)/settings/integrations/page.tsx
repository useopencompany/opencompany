import { IntegrationsSettingsRoute } from "@/components/AppRoutes";
import { browserProfilesAvailable } from "@/lib/browser-profiles";

export default function IntegrationsSettingsPage() {
  return <IntegrationsSettingsRoute browserProfilesEnabled={browserProfilesAvailable()} />;
}
