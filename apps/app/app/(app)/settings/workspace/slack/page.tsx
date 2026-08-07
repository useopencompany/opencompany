import { getDb } from "@opencompany/db/client";
import { brainSources } from "@opencompany/db/schema";
import { getSlackBotIntegrationForWorkspace } from "@opencompany/db/slack-bot";
import { and, count, eq } from "drizzle-orm";
import { SlackBotSettings } from "@/components/SlackBotSettings";
import { currentUser } from "@/lib/auth";
import { isSlackBotConfigured, slackBotScopesSatisfied } from "@/lib/integrations/slack-bot";

export default async function WorkspaceSlackBotSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string; reason?: string }>;
}) {
  const [context, params] = await Promise.all([currentUser(), searchParams]);
  const isAdmin = context.role === "admin";

  const integration = isAdmin
    ? await getSlackBotIntegrationForWorkspace(context.workspace.id)
    : null;
  const installed = Boolean(integration && integration.status !== "disconnected");

  let destinationCount = 0;
  if (integration && installed) {
    const [row] = await getDb()
      .select({ value: count() })
      .from(brainSources)
      .where(
        and(
          eq(brainSources.integrationId, integration.id),
          eq(brainSources.provider, "slack_bot"),
          eq(brainSources.enabled, true),
        ),
      );
    destinationCount = row?.value ?? 0;
  }

  return (
    <SlackBotSettings
      data={{
        isAdmin,
        configured: isSlackBotConfigured(),
        installed,
        status: integration && installed ? integration.status : "not_connected",
        needsScopeUpgrade: Boolean(
          integration &&
            installed &&
            integration.status === "connected" &&
            !slackBotScopesSatisfied(integration.scopes),
        ),
        teamName: integration?.connectionLabel ?? null,
        statusReason: integration?.statusReason ?? null,
        destinationCount,
        setup: params.setup === "connected" || params.setup === "error" ? params.setup : null,
        setupReason: params.reason ?? null,
      }}
    />
  );
}
