import { notFound } from "next/navigation";
import { ImessageSettings } from "@/components/ImessageSettings";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export default async function ImessageSettingsPage() {
  const response = await (await serverApiClient()).v1.me.imessage.$get();
  // The API answers 404 while the member's iMessage beta flag is off.
  if (response.status === 404) notFound();
  if (!response.ok) {
    throw new Error(await serverApiErrorMessage(response, "Could not load iMessage settings."));
  }
  return <ImessageSettings data={(await response.json()).data} />;
}
