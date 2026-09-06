import { SettingsRoute } from "@/components/Routes";
import { browserProfilesAvailable } from "@/lib/browser-profiles";

export default function SettingsPage() {
  return <SettingsRoute browserProfilesEnabled={browserProfilesAvailable()} />;
}
