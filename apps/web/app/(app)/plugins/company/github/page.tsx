import { CompanyGitHubPluginDetail } from "@/components/CompanyPluginSettings";
import {
  getCompanyGitHubPluginAction,
  listCompanyGitHubAvailableInstallationsAction,
} from "@/lib/company-plugin-actions";

// Every member can see which GitHub accounts the workspace connected, because their company
// automations bind triggers to them; the API decides who may change them.
export default async function CompanyGitHubPluginPage() {
  const plugin = await getCompanyGitHubPluginAction();
  const available = plugin.canManage ? await listCompanyGitHubAvailableInstallationsAction() : null;
  return <CompanyGitHubPluginDetail plugin={plugin} available={available} />;
}
