import { redirect } from "next/navigation";

export default function StripeSettingsPage() {
  redirect("/settings/plugins/stripe");
}
