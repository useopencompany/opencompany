import { notFound } from "next/navigation";
import { WhatsappSettings } from "@/components/PhoneChannelSettings";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export default async function WhatsappSettingsPage() {
  const response = await (await serverApiClient()).v1.me.whatsapp.$get();
  // The API answers 404 while the member's WhatsApp beta flag is off.
  if (response.status === 404) notFound();
  if (!response.ok) {
    throw new Error(await serverApiErrorMessage(response, "Could not load WhatsApp settings."));
  }
  return <WhatsappSettings data={(await response.json()).data} />;
}
