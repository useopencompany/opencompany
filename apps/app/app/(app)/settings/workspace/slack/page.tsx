import { getDb } from "@opencompany/db/client";
import { goatBrainSources } from "@opencompany/db/schema";
import { getGoatSlackBotIntegrationForWorkspace } from "@opencompany/db/slack-bot";
import { and, count, eq } from "drizzle-orm";
import { GoatSlackBotSettings } from "@/components/GoatSlackBotSettings";
import { currentGoatUser } from "@/lib/auth";
import {
  goatSlackBotScopesSatisfied,
  isGoatSlackBotConfigured,
} from "@/lib/integrations/slack-bot";

export default async function WorkspaceSlackBotSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string; reason?: string }>;
}) {
  const [context, params] = await Promise.all([currentGoatUser(), searchParams]);
  const isAdmin = context.role === "admin";

  const integration = isAdmin
    ? await getGoatSlackBotIntegrationForWorkspace(context.workspace.id)
    : null;
  const installed = Boolean(integration && integration.status !== "disconnected");

  let destinationCount = 0;
  if (integration && installed) {
    const [row] = await getDb()
      .select({ value: count() })
      .from(goatBrainSources)
      .where(
        and(
          eq(goatBrainSources.integrationId, integration.id),
          eq(goatBrainSources.provider, "slack_bot"),
          eq(goatBrainSources.enabled, true),
        ),
      );
    destinationCount = row?.value ?? 0;
  }

  return (
    <GoatSlackBotSettings
      data={{
        isAdmin,
        configured: isGoatSlackBotConfigured(),
        installed,
        status: integration && installed ? integration.status : "not_connected",
        needsScopeUpgrade: Boolean(
          integration &&
            installed &&
            integration.status === "connected" &&
            !goatSlackBotScopesSatisfied(integration.scopes),
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
