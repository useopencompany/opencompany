"use server";

import { getDb } from "@opencompany/db/client";
import {
  hasAnyBrainSourceForIntegration,
  listGoatBrainSourcesForBrain,
  upsertGoatBrainSource,
} from "@opencompany/db/goat-brain-sources";
import {
  type GoatBrainSourceConfigProvider,
  type GoatIntegrationProvider,
  type GoatIntegrationStatus,
  goatIntegrations,
} from "@opencompany/db/goat-schema";
import { getDefaultGoatBrainForUser, getGoatBrainAccess } from "@opencompany/db/goat-workspaces";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import type { GoatJamieProviderState } from "@/lib/integration-state";
import { getGoatJamieIntegrationState } from "@/lib/integrations/jamie";
import type { GoatWorkspaceActionResult } from "@/lib/workspace-actions";

export type GoatBrainSourceView = {
  provider: GoatBrainSourceConfigProvider;
  integrationId: string;
  enabled: boolean;
  connectedByName: string;
  isOwnIntegration: boolean;
  integrationStatus: GoatIntegrationStatus;
};

export type GoatBrainSourcesDetails = {
  sources: GoatBrainSourceView[];
  jamie: {
    integration: GoatJamieProviderState;
    // No explicit per-brain rows exist yet for the user's Jamie integration, so
    // deliveries still follow the legacy default-brain routing.
    legacyDefaultDelivery: boolean;
    // This brain is the acting user's default brain (the legacy delivery target).
    isDefaultBrain: boolean;
  };
};

function integrationProviderFor(
  provider: GoatBrainSourceConfigProvider,
): GoatIntegrationProvider | null {
  switch (provider) {
    case "jamie":
    case "gmail":
    case "github":
      return provider;
    default:
      return null;
  }
}

async function requireAdminBrainContext(brainId: string) {
  const context = await currentGoatUser();
  if (context.role !== "admin") return null;
  const access = await getGoatBrainAccess({
    userWorkosId: context.user.workosUserId,
    brainRef: brainId,
  });
  if (!access || access.brain.workspaceId !== context.workspace.id) return null;
  return context;
}

export async function getGoatBrainSourcesAction(
  brainId: string,
): Promise<GoatBrainSourcesDetails | null> {
  const context = await requireAdminBrainContext(brainId);
  if (!context) return null;

  const [sources, jamieState, defaultBrain] = await Promise.all([
    listGoatBrainSourcesForBrain(brainId),
    getGoatJamieIntegrationState(context.user.workosUserId),
    getDefaultGoatBrainForUser(context.user.workosUserId),
  ]);

  const jamieConfigured = jamieState.integrationId
    ? await hasAnyBrainSourceForIntegration(jamieState.integrationId)
    : false;

  return {
    sources: sources.map((source) => ({
      provider: source.provider,
      integrationId: source.integrationId,
      enabled: source.enabled,
      connectedByName: source.ownerName ?? source.ownerEmail ?? "Unknown",
      isOwnIntegration: source.userWorkosId === context.user.workosUserId,
      integrationStatus: source.integrationStatus,
    })),
    jamie: {
      integration: jamieState,
      legacyDefaultDelivery: jamieState.connected && !jamieConfigured,
      isDefaultBrain: defaultBrain?.id === brainId,
    },
  };
}

export async function setGoatBrainSourceEnabledAction(input: {
  brainId: string;
  provider: GoatBrainSourceConfigProvider;
  integrationId: string;
  enabled: boolean;
}): Promise<GoatWorkspaceActionResult> {
  const context = await requireAdminBrainContext(input.brainId);
  if (!context) {
    return { ok: false, error: "Only workspace admins can configure brain sources." };
  }

  // Source providers without a matching integration provider (e.g. slack, for
  // now) cannot be configured yet.
  const integrationProvider = integrationProviderFor(input.provider);
  if (!integrationProvider) {
    return { ok: false, error: "This source is not available yet." };
  }

  const [integration] = await getDb()
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, input.integrationId),
        eq(goatIntegrations.userWorkosId, context.user.workosUserId),
        eq(goatIntegrations.provider, integrationProvider),
      ),
    )
    .limit(1);
  if (!integration || integration.status === "disconnected") {
    return { ok: false, error: "Connect this integration in your settings first." };
  }

  try {
    const hadExplicitConfig = await hasAnyBrainSourceForIntegration(input.integrationId);

    // First explicit row for this integration ends the legacy default-brain
    // routing; materialize the default brain's row so delivery there doesn't
    // silently stop.
    if (!hadExplicitConfig) {
      const defaultBrain = await getDefaultGoatBrainForUser(context.user.workosUserId);
      if (defaultBrain && defaultBrain.id !== input.brainId) {
        await upsertGoatBrainSource({
          brainId: defaultBrain.id,
          provider: input.provider,
          integrationId: input.integrationId,
          userWorkosId: context.user.workosUserId,
          createdByWorkosId: context.user.workosUserId,
          enabled: true,
        });
      }
    }

    await upsertGoatBrainSource({
      brainId: input.brainId,
      provider: input.provider,
      integrationId: input.integrationId,
      userWorkosId: context.user.workosUserId,
      createdByWorkosId: context.user.workosUserId,
      enabled: input.enabled,
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the brain source.",
    };
  }
}
