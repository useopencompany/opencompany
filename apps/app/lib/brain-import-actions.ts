"use server";

import { GITHUB_ACTIVITY_EVENT_TYPES } from "@opencompany/brain";
import {
  cancelBrainImport,
  confirmBrainImport,
  createBrainImportRun,
  retryBrainImportDiscovery,
} from "@opencompany/db/brain-import";
import type { BrainImportProvider, BrainImportSourceSelection } from "@opencompany/db/schema";
import { currentBrainByRef } from "@/lib/auth";
import { getBrainSourcesAction, listGitHubRepositoriesAction } from "./brain-source-actions";
import { triggerBrainImportWake, triggerBrainIngestWake } from "./task-runner";

const IMPORT_INTEGRATION_PROVIDERS = [
  "github",
  "jamie",
  "granola",
  "fathom",
  "gmail",
  "slack",
  "linear",
] as const;
const IMPORT_PROVIDERS = ["public_web", ...IMPORT_INTEGRATION_PROVIDERS] as const;

export type BrainImportActionResult =
  | { ok: true; importRunId: string }
  | { ok: false; message: string };

export async function startBrainImportDiscoveryAction(input: {
  brainRef: string;
  companyUrl: string;
  focus?: string;
  sourceSelection: BrainImportSourceSelection;
}): Promise<BrainImportActionResult> {
  try {
    const context = await requireAdminBrain(input.brainRef);
    const sourceSelection = await validateImportSourceSelection(
      input.brainRef,
      input.sourceSelection,
    );
    const run = await createBrainImportRun({
      brainRef: input.brainRef,
      userWorkosId: context.user.workosUserId,
      companyUrl: input.companyUrl,
      ...(input.focus?.trim() ? { focus: input.focus } : {}),
      sourceSelection,
    });
    await wakeImportWorkers([triggerBrainImportWake()]);
    return { ok: true, importRunId: run.id };
  } catch (error) {
    return failure(error);
  }
}

export async function confirmBrainImportAction(input: {
  brainRef: string;
  importRunId: string;
  enabledProviders: BrainImportProvider[];
}): Promise<BrainImportActionResult> {
  try {
    const context = await requireAdminBrain(input.brainRef);
    await confirmBrainImport({
      importRunId: input.importRunId,
      brainRef: input.brainRef,
      enabledProviders: sanitizeEnabledProviders(input.enabledProviders),
      actingUserWorkosId: context.user.workosUserId,
    });
    await wakeImportWorkers([triggerBrainIngestWake(), triggerBrainImportWake()]);
    return { ok: true, importRunId: input.importRunId };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelBrainImportAction(input: {
  brainRef: string;
  importRunId: string;
}): Promise<BrainImportActionResult> {
  try {
    await requireAdminBrain(input.brainRef);
    await cancelBrainImport(input);
    await wakeImportWorkers([triggerBrainImportWake()]);
    return { ok: true, importRunId: input.importRunId };
  } catch (error) {
    return failure(error);
  }
}

export async function retryBrainImportDiscoveryAction(input: {
  brainRef: string;
  importRunId: string;
}): Promise<BrainImportActionResult> {
  try {
    await requireAdminBrain(input.brainRef);
    await retryBrainImportDiscovery(input);
    await wakeImportWorkers([triggerBrainImportWake()]);
    return { ok: true, importRunId: input.importRunId };
  } catch (error) {
    return failure(error);
  }
}

async function requireAdminBrain(brainRef: string) {
  const resolved = await currentBrainByRef(brainRef);
  if (resolved.context.role !== "admin") {
    throw new Error("Only workspace admins can import company context.");
  }
  return resolved.context;
}

function failure(error: unknown): BrainImportActionResult {
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
  selection: BrainImportSourceSelection,
): Promise<BrainImportSourceSelection> {
  const details = await getBrainSourcesAction(brainRef);
  if (!details) throw new Error("Only workspace admins can import company context.");

  const next: BrainImportSourceSelection = {
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
      const repositories = await listGitHubRepositoriesAction(requested.integrationId);
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
  details: NonNullable<Awaited<ReturnType<typeof getBrainSourcesAction>>>,
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

function sanitizeEnabledProviders(value: unknown): BrainImportProvider[] {
  if (!Array.isArray(value)) throw new Error("Choose the sources to import.");
  const allowed = new Set<string>(IMPORT_PROVIDERS);
  return Array.from(
    new Set(
      value.filter(
        (provider): provider is BrainImportProvider =>
          typeof provider === "string" && allowed.has(provider),
      ),
    ),
  );
}
