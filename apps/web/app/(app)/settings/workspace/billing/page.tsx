import { BillingPanel } from "@/components/BillingPanel";
import { serverApiClient, serverApiError } from "@/lib/server-api-client";

export default async function WorkspaceBillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; topup?: string }>;
}) {
  const [client, params] = await Promise.all([serverApiClient(), searchParams]);
  const response = await client.v1.billing.$get();
  if (!response.ok) throw await serverApiError(response, "Could not load workspace billing.");
  const data = (await response.json()).data;
  return (
    <BillingPanel
      data={data}
      topupResult={
        params.topup === "success" ? "success" : params.topup === "cancelled" ? "cancelled" : null
      }
      checkoutResult={
        params.checkout === "success"
          ? "success"
          : params.checkout === "cancelled"
            ? "cancelled"
            : null
      }
    />
  );
}
