import {
  type Actor,
  actorHasPermission,
  BRAIN_READ_PERMISSION,
  CoreError,
  WIKI_READ_PERMISSION,
  WIKI_WRITE_PERMISSION,
} from "@opencompany/core";
import {
  cancelBrainImport,
  cancelWikiImport,
  confirmBrainImport,
  confirmWikiImport,
  normalizeCompanyUrl,
  retryBrainImportDiscovery,
  retryWikiImportDiscovery,
  startBrainImportRunIdempotent,
  startWikiImportRunIdempotent,
} from "@opencompany/db/brain-import";
import type {
  BrainImportProvider,
  BrainImportSourceSelection,
  BrainImportStatus,
} from "@opencompany/db/product-schema";
import { getBrainAccess, isLegacyBrainEnabledForWorkspace } from "@opencompany/db/workspaces";
import type { WikiSourceDto } from "@opencompany/protocol";
import type { BrainSourceApplicationService } from "./brain-sources";

type DbLike = any;

const IMPORT_INTEGRATION_PROVIDERS = ["granola", "fathom", "gmail", "linear"] as const;
const IMPORT_PROVIDERS = ["public_web", ...IMPORT_INTEGRATION_PROVIDERS] as const;
const WIKI_IMPORT_INTEGRATION_PROVIDERS = ["granola", "gmail", "linear"] as const;
const WIKI_IMPORT_PROVIDERS = ["public_web", ...WIKI_IMPORT_INTEGRATION_PROVIDERS] as const;

type ImportIntegrationProvider = (typeof IMPORT_INTEGRATION_PROVIDERS)[number];

// The command accepts the same requested shape the Brain sources catalog exposes. Provider
// configuration is re-derived server-side after ownership and capability checks.
export type BrainImportSelectionInput = Record<
  string,
  {
    enabled: boolean;
    integrationId?: string;
  }
>;

export type BrainImportCommandResult = {
  importRunId: string;
  status: BrainImportStatus;
  replayed: boolean;
};

export class BrainImportApplicationService {
  constructor(
    private readonly db: DbLike,
    private readonly brainSources: Pick<BrainSourceApplicationService, "list" | "listOptions">,
  ) {}

  async start(
    actor: Actor,
    brainId: string,
    input: {
      idempotencyKey: string;
      companyUrl: string;
      focus?: string;
      sourceSelection: BrainImportSelectionInput;
    },
  ): Promise<BrainImportCommandResult> {
    const id = await this.authorizeAdminBrain(actor, brainId);
    let company: { url: string; domain: string };
    try {
      company = normalizeCompanyUrl(input.companyUrl);
    } catch (error) {
      throw new CoreError(
        "invalid_argument",
        error instanceof Error ? error.message : "Enter a valid company website.",
      );
    }
    const focus = boundedOptional(input.focus, 2_000, "focus");
    const sourceSelection = await this.validateSelection(actor, id, input.sourceSelection);
    const result = await startBrainImportRunIdempotent({
      actor,
      brainRef: id,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      companyUrl: company.url,
      focus: focus ?? null,
      sourceSelection,
      db: this.db,
    });
    return {
      importRunId: result.run.id,
      status: result.run.status,
      replayed: result.idempotentReplay,
    };
  }

  async confirm(
    actor: Actor,
    brainId: string,
    importRunId: string,
    enabledProviders: BrainImportProvider[],
  ): Promise<BrainImportCommandResult> {
    const id = await this.authorizeAdminBrain(actor, brainId);
    const runId = resourceId(importRunId, "importRunId");
    await confirmBrainImport({
      importRunId: runId,
      brainRef: id,
      enabledProviders: sanitizeEnabledProviders(enabledProviders),
      actingUserWorkosId: actor.userId,
      db: this.db,
    });
    return { importRunId: runId, status: "ingesting", replayed: false };
  }

  async cancel(
    actor: Actor,
    brainId: string,
    importRunId: string,
  ): Promise<BrainImportCommandResult> {
    const id = await this.authorizeAdminBrain(actor, brainId);
    const runId = resourceId(importRunId, "importRunId");
    await cancelBrainImport({ importRunId: runId, brainRef: id, db: this.db });
    return { importRunId: runId, status: "canceled", replayed: false };
  }

  async retry(
    actor: Actor,
    brainId: string,
    importRunId: string,
  ): Promise<BrainImportCommandResult> {
    const id = await this.authorizeAdminBrain(actor, brainId);
    const runId = resourceId(importRunId, "importRunId");
    await retryBrainImportDiscovery({ importRunId: runId, brainRef: id, db: this.db });
    return { importRunId: runId, status: "discovering", replayed: false };
  }

  private async authorizeAdminBrain(actor: Actor, brainId: string) {
    if (
      !actor.userId.trim() ||
      !actor.workspaceId.trim() ||
      !actorHasPermission(actor, BRAIN_READ_PERMISSION)
    ) {
      throw new CoreError("forbidden", "The actor is not allowed to read Brains.");
    }
    const id = resourceId(brainId, "brainId");
    const access = await getBrainAccess(
      { userWorkosId: actor.userId, brainRef: id },
      { db: this.db },
    );
    if (!access || access.brain.workspaceId !== actor.workspaceId) {
      throw new CoreError("not_found", "Brain not found.");
    }
    if (actor.role !== "admin") {
      throw new CoreError("forbidden", "Only workspace admins can import company context.");
    }
    return id;
  }

  private async validateSelection(
    actor: Actor,
    brainId: string,
    selection: BrainImportSelectionInput,
  ): Promise<BrainImportSourceSelection> {
    const details = await this.brainSources.list(actor, brainId);
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
        throw new CoreError(
          "invalid_argument",
          `Connect ${providerLabel(provider)} in your settings first.`,
        );
      }

      let config: Record<string, unknown> = manageableSource?.config ?? {};
      if (provider === "gmail") {
        const existingEvents = Array.isArray(config.events) ? config.events : [];
        if (existingEvents.length === 0) {
          config = {
            ...config,
            events: [{ id: "email_received" }, { id: "email_sent" }],
          };
        }
      }
      if (provider === "linear" && !hasConfiguredEntries(config.teams)) {
        throw new CoreError(
          "invalid_argument",
          "Select at least one Linear team in Brain Settings first.",
        );
      }
      next[provider] = {
        enabled: true,
        integrationId: requested.integrationId,
        config,
      };
    }
    return next;
  }
}

export class WikiImportApplicationService {
  constructor(
    private readonly db: DbLike,
    private readonly wikiSources: { list(actor: Actor): Promise<WikiSourceDto[]> },
  ) {}

  async start(
    actor: Actor,
    input: {
      idempotencyKey: string;
      companyUrl: string;
      focus?: string;
      sourceSelection: BrainImportSelectionInput;
    },
  ): Promise<BrainImportCommandResult> {
    await this.authorizeAdminWiki(actor);
    let company: { url: string; domain: string };
    try {
      company = normalizeCompanyUrl(input.companyUrl);
    } catch (error) {
      throw new CoreError(
        "invalid_argument",
        error instanceof Error ? error.message : "Enter a valid company website.",
      );
    }
    const result = await startWikiImportRunIdempotent({
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      companyUrl: company.url,
      focus: boundedOptional(input.focus, 2_000, "focus") ?? null,
      sourceSelection: await this.validateSelection(actor, input.sourceSelection),
      db: this.db,
    });
    return {
      importRunId: result.run.id,
      status: result.run.status,
      replayed: result.idempotentReplay,
    };
  }

  async confirm(
    actor: Actor,
    importRunId: string,
    enabledProviders: BrainImportProvider[],
  ): Promise<BrainImportCommandResult> {
    await this.authorizeAdminWiki(actor);
    const runId = resourceId(importRunId, "importRunId");
    await confirmWikiImport({
      importRunId: runId,
      workspaceId: actor.workspaceId,
      enabledProviders: sanitizeWikiEnabledProviders(enabledProviders),
      actingUserWorkosId: actor.userId,
      db: this.db,
    });
    return { importRunId: runId, status: "ingesting", replayed: false };
  }

  async cancel(actor: Actor, importRunId: string): Promise<BrainImportCommandResult> {
    await this.authorizeAdminWiki(actor);
    const runId = resourceId(importRunId, "importRunId");
    await cancelWikiImport({ importRunId: runId, workspaceId: actor.workspaceId, db: this.db });
    return { importRunId: runId, status: "canceled", replayed: false };
  }

  async retry(actor: Actor, importRunId: string): Promise<BrainImportCommandResult> {
    await this.authorizeAdminWiki(actor);
    const runId = resourceId(importRunId, "importRunId");
    await retryWikiImportDiscovery({
      importRunId: runId,
      workspaceId: actor.workspaceId,
      db: this.db,
    });
    return { importRunId: runId, status: "discovering", replayed: false };
  }

  private async authorizeAdminWiki(actor: Actor) {
    if (
      !actor.userId.trim() ||
      !actor.workspaceId.trim() ||
      !actorHasPermission(actor, WIKI_READ_PERMISSION) ||
      !actorHasPermission(actor, WIKI_WRITE_PERMISSION)
    ) {
      throw new CoreError("forbidden", "The actor is not allowed to write to the Wiki.");
    }
    if (actor.role !== "admin") {
      throw new CoreError("forbidden", "Only workspace admins can import company context.");
    }
    if (await isLegacyBrainEnabledForWorkspace(actor.workspaceId, { db: this.db })) {
      throw new CoreError("not_found", "Wiki import is unavailable in this workspace.");
    }
  }

  private async validateSelection(
    actor: Actor,
    selection: BrainImportSelectionInput,
  ): Promise<BrainImportSourceSelection> {
    const sources = await this.wikiSources.list(actor);
    const next: BrainImportSourceSelection = {
      public_web: { enabled: selection.public_web?.enabled !== false },
    };
    for (const provider of WIKI_IMPORT_INTEGRATION_PROVIDERS) {
      const requested = selection[provider];
      if (!requested?.enabled) {
        next[provider] = { enabled: false };
        continue;
      }
      const source = sources.find(
        (candidate) =>
          candidate.provider === provider &&
          candidate.integrationId === requested.integrationId &&
          candidate.canConfigure &&
          candidate.integrationStatus === "connected",
      );
      if (!source) {
        throw new CoreError(
          "invalid_argument",
          `Configure ${providerLabel(provider)} in Wiki Sources first.`,
        );
      }
      if (provider === "linear" && !hasConfiguredEntries(source.config.teams)) {
        throw new CoreError("invalid_argument", "Select at least one Linear team.");
      }
      next[provider] = {
        enabled: true,
        integrationId: source.integrationId,
        config: source.config,
      };
    }
    return next;
  }
}

function integrationIdFor(
  details: Awaited<ReturnType<BrainSourceApplicationService["list"]>>,
  provider: ImportIntegrationProvider,
) {
  return details[provider].integration.integrationId ?? null;
}

function providerLabel(provider: ImportIntegrationProvider) {
  return provider[0]!.toUpperCase() + provider.slice(1);
}

function hasConfiguredEntries(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

// An empty list is allowed and confirms the run with every provider's candidates disabled,
// matching the pre-cutover Server Action behavior.
function sanitizeEnabledProviders(value: BrainImportProvider[]): BrainImportProvider[] {
  const allowed = new Set<string>(IMPORT_PROVIDERS);
  return Array.from(
    new Set(value.filter((provider) => typeof provider === "string" && allowed.has(provider))),
  );
}

function sanitizeWikiEnabledProviders(value: BrainImportProvider[]): BrainImportProvider[] {
  const allowed = new Set<string>(WIKI_IMPORT_PROVIDERS);
  return Array.from(
    new Set(value.filter((provider) => typeof provider === "string" && allowed.has(provider))),
  );
}

function resourceId(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[^\w:.-]/u.test(normalized)) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return normalized;
}

function idempotencyKey(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[^\x21-\x7e]/u.test(normalized)) {
    throw new CoreError("invalid_argument", "A valid Idempotency-Key is required.");
  }
  return normalized;
}

function boundedOptional(value: string | undefined, max: number, field: string) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > max) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return normalized;
}
