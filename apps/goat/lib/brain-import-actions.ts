"use server";

import {
  cancelGoatBrainImport,
  confirmGoatBrainImport,
  createGoatBrainImportRun,
  retryGoatBrainImportDiscovery,
} from "@opencompany/db/goat-brain-import";
import type {
  GoatBrainImportProvider,
  GoatBrainImportSourceSelection,
} from "@opencompany/db/goat-schema";
import { GITHUB_ACTIVITY_EVENT_TYPES } from "@opencompany/goat-brain";
import { currentGoatBrainByRef } from "@/lib/auth";
import {
  getGoatBrainSourcesAction,
  listGoatGitHubRepositoriesAction,
} from "./brain-source-actions";
import { triggerGoatBrainImportWake, triggerGoatBrainIngestWake } from "./task-runner";

const IMPORT_INTEGRATION_PROVIDERS = [
  "github",
  "jamie",
  "granola",
  "gmail",
  "slack",
  "linear",
] as const;
const IMPORT_PROVIDERS = ["public_web", ...IMPORT_INTEGRATION_PROVIDERS] as const;

export type GoatBrainImportActionResult =
  | { ok: true; importRunId: string }
  | { ok: false; message: string };

export async function startGoatBrainImportDiscoveryAction(input: {
  brainRef: string;
  companyUrl: string;
  focus?: string;
  sourceSelection: GoatBrainImportSourceSelection;
}): Promise<GoatBrainImportActionResult> {
  try {
    const context = await requireAdminBrain(input.brainRef);
    const sourceSelection = await validateImportSourceSelection(
      input.brainRef,
      input.sourceSelection,
    );
    const run = await createGoatBrainImportRun({
      brainRef: input.brainRef,
      userWorkosId: context.user.workosUserId,
      companyUrl: input.companyUrl,
      ...(input.focus?.trim() ? { focus: input.focus } : {}),
      sourceSelection,
    });
    await wakeImportWorkers([triggerGoatBrainImportWake()]);
    return { ok: true, importRunId: run.id };
  } catch (error) {
    return failure(error);
  }
}

export async function confirmGoatBrainImportAction(input: {
  brainRef: string;
  importRunId: string;
  enabledProviders: GoatBrainImportProvider[];
}): Promise<GoatBrainImportActionResult> {
  try {
    const context = await requireAdminBrain(input.brainRef);
    await confirmGoatBrainImport({
      importRunId: input.importRunId,
      brainRef: input.brainRef,
      enabledProviders: sanitizeEnabledProviders(input.enabledProviders),
      actingUserWorkosId: context.user.workosUserId,
    });
    await wakeImportWorkers([triggerGoatBrainIngestWake(), triggerGoatBrainImportWake()]);
    return { ok: true, importRunId: input.importRunId };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelGoatBrainImportAction(input: {
  brainRef: string;
  importRunId: string;
}): Promise<GoatBrainImportActionResult> {
  try {
    await requireAdminBrain(input.brainRef);
    await cancelGoatBrainImport(input);
    await wakeImportWorkers([triggerGoatBrainImportWake()]);
    return { ok: true, importRunId: input.importRunId };
  } catch (error) {
    return failure(error);
  }
}

export async function retryGoatBrainImportDiscoveryAction(input: {
  brainRef: string;
  importRunId: string;
}): Promise<GoatBrainImportActionResult> {
  try {
    await requireAdminBrain(input.brainRef);
    await retryGoatBrainImportDiscovery(input);
    await wakeImportWorkers([triggerGoatBrainImportWake()]);
    return { ok: true, importRunId: input.importRunId };
  } catch (error) {
    return failure(error);
  }
}

async function requireAdminBrain(brainRef: string) {
  const resolved = await currentGoatBrainByRef(brainRef);
  if (resolved.context.role !== "admin") {
    throw new Error("Only workspace admins can import company context.");
  }
  return resolved.context;
}

function failure(error: unknown): GoatBrainImportActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "The company-context import failed.",
  };
}

async function wakeImportWorkers(wakes: Promise<unknown>[]) {
  const results = await Promise.allSettled(wakes);
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("A Goat Brain import worker wake-up failed; polling will recover it.", {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}

async function validateImportSourceSelection(
  brainRef: string,
  selection: GoatBrainImportSourceSelection,
): Promise<GoatBrainImportSourceSelection> {
  const details = await getGoatBrainSourcesAction(brainRef);
  if (!details) throw new Error("Only workspace admins can import company context.");

  const next: GoatBrainImportSourceSelection = {
    public_web: { enabled: selection.public_web?.enabled !== false },
  };
  for (const provider of IMPORT_INTEGRATION_PROVIDERS) {
    const requested = selection[provider];
    if (!requested?.enabled) {
      next[provider] = { enabled: false };
      continue;
    }

    const manageableSource = details.sources.find(
      (source) =>
        source.provider === provider &&
        source.integrationId === requested.integrationId &&
        source.canConfigure,
    );
    const connectedIntegrationId = integrationIdFor(details, provider);
    if (
      !requested.integrationId ||
      (!manageableSource && requested.integrationId !== connectedIntegrationId)
    ) {
      throw new Error(`Connect ${providerLabel(provider)} in your settings first.`);
    }

    let config = manageableSource?.config ?? {};
    if (provider === "github" && !manageableSource) {
      const repositories = await listGoatGitHubRepositoriesAction(requested.integrationId);
      if (!repositories.ok) throw new Error(repositories.error);
      const requestedRepos = Array.isArray(requested.config?.repos) ? requested.config.repos : [];
      const requestedKeys = new Set(
        requestedRepos.flatMap((repo) => {
          if (!repo || typeof repo !== "object") return [];
          const value = repo as { id?: unknown; fullName?: unknown };
          return [value.id, value.fullName].filter(
            (key): key is string => typeof key === "string" && key.length > 0,
          );
        }),
      );
      const repos = repositories.repos
        .filter((repo) => requestedKeys.has(repo.id) || requestedKeys.has(repo.fullName))
        .slice(0, 5)
        .map(({ id, fullName }) => ({ id, fullName }));
      config = { repos, events: [...GITHUB_ACTIVITY_EVENT_TYPES] };
    }
    if (provider === "gmail") {
      const existingEvents = Array.isArray(config.events) ? config.events : [];
      if (existingEvents.length === 0) {
        config = {
          ...config,
          events: [{ id: "email_received" }, { id: "email_sent" }],
        };
      }
    }
    if (provider === "github" && !hasConfiguredEntries(config.repos)) {
      throw new Error("Select at least one GitHub repository.");
    }
    if (
      provider === "slack" &&
      !hasConfiguredEntries(config.channels) &&
      !hasConfiguredEntries(config.dms)
    ) {
      throw new Error("Select at least one Slack channel or DM in Brain Settings first.");
    }
    if (provider === "linear" && !hasConfiguredEntries(config.teams)) {
      throw new Error("Select at least one Linear team in Brain Settings first.");
    }
    next[provider] = {
      enabled: true,
      integrationId: requested.integrationId,
      config,
    };
  }
  return next;
}

function integrationIdFor(
  details: NonNullable<Awaited<ReturnType<typeof getGoatBrainSourcesAction>>>,
  provider: (typeof IMPORT_INTEGRATION_PROVIDERS)[number],
) {
  return details[provider].integration.integrationId ?? null;
}

function providerLabel(provider: (typeof IMPORT_INTEGRATION_PROVIDERS)[number]) {
  return provider === "github" ? "GitHub" : provider[0]!.toUpperCase() + provider.slice(1);
}

function hasConfiguredEntries(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

function sanitizeEnabledProviders(value: unknown): GoatBrainImportProvider[] {
  if (!Array.isArray(value)) throw new Error("Choose the sources to import.");
  const allowed = new Set<string>(IMPORT_PROVIDERS);
  return Array.from(
    new Set(
      value.filter(
        (provider): provider is GoatBrainImportProvider =>
          typeof provider === "string" && allowed.has(provider),
      ),
    ),
  );
}
