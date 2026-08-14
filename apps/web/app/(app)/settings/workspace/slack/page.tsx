import { SlackBotSettings } from "@/components/SlackBotSettings";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export default async function WorkspaceSlackBotSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string; reason?: string }>;
}) {
  const [response, params] = await Promise.all([
    (await serverApiClient()).v1.workspace["slack-bot"].$get(),
    searchParams,
  ]);
  if (!response.ok) {
    throw new Error(
      await serverApiErrorMessage(response, "Could not load the Slack bot settings."),
    );
  }
  const data = (await response.json()).data;

  return (
    <SlackBotSettings
      data={{
        ...data,
        setup: params.setup === "connected" || params.setup === "error" ? params.setup : null,
        setupReason: params.reason ?? null,
      }}
    />
  );
}
