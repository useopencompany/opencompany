import { IntegrationsSettingsRoute } from "@/components/Routes";
import { browserProfilesAvailable } from "@/lib/browser-profiles";

export default function IntegrationsSettingsPage() {
  return <IntegrationsSettingsRoute browserProfilesEnabled={browserProfilesAvailable()} />;
}
