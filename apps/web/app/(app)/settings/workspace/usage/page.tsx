import { GoatUsagePanel } from "@/components/GoatIngestionUsagePanel";
import { serverApiClient, serverApiError } from "@/lib/server-api-client";

export default async function WorkspaceUsageSettingsPage() {
  const client = await serverApiClient();
  const response = await client.v1.billing.usage.$get();
  if (!response.ok) throw await serverApiError(response, "Could not load workspace usage.");
  return <GoatUsagePanel data={(await response.json()).data} />;
}
