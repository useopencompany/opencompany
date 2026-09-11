import { AddCustomMcpPlugin } from "@/components/CustomMcpPluginSettings";
import { currentUser } from "@/lib/auth";

export default async function AddCustomMcpPage() {
  await currentUser();
  return <AddCustomMcpPlugin canEdit={true} />;
}
