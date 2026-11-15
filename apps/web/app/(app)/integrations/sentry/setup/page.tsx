import { SentryPluginSettings } from "@/components/SentryPluginSettings";
import { getCompanySentryPluginAction } from "@/lib/sentry-actions";
export const metadata = { referrer: "no-referrer" };
export default async function SentrySetupPage({
  searchParams,
}: {
  searchParams: Promise<{ installationId?: string; code?: string }>;
}) {
  const params = await searchParams;
  const plugin = await getCompanySentryPluginAction();
  if (!params.installationId || !params.code) return <p>Invalid Sentry installation link.</p>;
  return (
    <SentryPluginSettings
      plugin={plugin}
      projects={[]}
      installation={{ id: params.installationId, code: params.code }}
    />
  );
}
