import { AddCustomMcpPlugin } from "@/components/CustomMcpPluginSettings";
import { currentUser } from "@/lib/auth";

export default async function AddCustomMcpPage() {
  const context = await currentUser();
  return <AddCustomMcpPlugin canEdit={context.role === "admin"} />;
}
