import {
  createGoatBrainFolderRow,
  deleteGoatBrainFolderRow,
} from "@opencompany/db/goat-brain-files";
import type { GoatWorkspaceWithRole } from "@opencompany/db/goat-workspaces";
import {
  DEFAULT_GOAT_BRAIN_SLUG,
  getGoatOnboarding,
  hasOwnedGoatHobbyWorkspace,
  isGoatWorkspaceSlugAvailable,
  listAccessibleGoatBrains,
  listGoatWorkspacesForUser,
  markGoatUserOnboarded,
  updateGoatWorkspaceNameAndSlug,
  upsertGoatOnboarding,
} from "@opencompany/db/goat-workspaces";
import { goatOnboardingFoldersForRole } from "@opencompany/goat-agent/onboarding-profile";
import { ensureGoatWorkspaceOrganization } from "@opencompany/goat-agent/workspaces/organizations";
import {
  GoatWorkspaceProvisioningError,
  provisionGoatWorkspace,
} from "@opencompany/goat-agent/workspaces/provisioning";
import { ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS } from "@opencompany/goat-brain/schema";
import { createLogger } from "@opencompany/observability";
import type { WorkOS } from "@workos-inc/node";
import type { ApiIdentity } from "./auth";
import { ApiError } from "./errors";

type DbLike = any;

const logger = createLogger({ service: "opencompany-api", runtime: "onboarding" });

export type OnboardingStateView = {
  onboarding: {
    role: string | null;
    companyDomain: string | null;
    contextUrls: string[] | null;
    referralSource: string | null;
  } | null;
  workspace: {
    id: string;
    name: string;
    slug: string | null;
    createdByCaller: boolean;
  } | null;
  activeBrainId: string | null;
};

export type OnboardingWorkspaceView = {
  workspaceId: string;
  organizationId: string;
  brainId: string;
  createdByCaller: boolean;
};

export type OnboardingService = {
  getState(identity: ApiIdentity): Promise<OnboardingStateView>;
  checkSlug(identity: ApiIdentity, rawSlug: string): Promise<{ slug: string; available: boolean }>;
  saveProfile(identity: ApiIdentity, profile: { role: string; companyUrl: string }): Promise<void>;
  saveWorkspace(
    identity: ApiIdentity,
    command: { workspaceId: string; name: string; slug: string },
  ): Promise<OnboardingWorkspaceView>;
  finish(identity: ApiIdentity, referralSource: string | null): Promise<void>;
};

export function createOnboardingService(input: { db: DbLike; workos: WorkOS }): OnboardingService {
  const { db, workos } = input;

  return {
    async getState(identity) {
      const [onboarding, context] = await Promise.all([
        getGoatOnboarding(identity.userId, { db }),
        resolveOnboardingContext(identity, db),
      ]);
      const brain = context ? await activeBrain(identity.userId, context.workspace.id, db) : null;
      return {
        onboarding: onboarding
          ? {
              role: onboarding.role,
              companyDomain: onboarding.companyDomain,
              contextUrls: onboarding.contextUrls,
              referralSource: onboarding.referralSource,
            }
          : null,
        workspace: context
          ? {
              id: context.workspace.id,
              name: context.workspace.name,
              slug: context.workspace.slug,
              createdByCaller: context.workspace.createdByWorkosId === identity.userId,
            }
          : null,
        activeBrainId: brain?.id ?? null,
      };
    },

    async checkSlug(identity, rawSlug) {
      const slug = normalizeWorkspaceSlug(rawSlug);
      if (!slug) return { slug, available: false };
      const context = await resolveOnboardingContext(identity, db);
      const available = await isGoatWorkspaceSlugAvailable(
        {
          slug,
          ...(context ? { excludeWorkspaceId: context.workspace.id } : {}),
        },
        { db },
      );
      return { slug, available };
    },

    async saveProfile(identity, profile) {
      const companyUrl = new URL(profile.companyUrl);
      const context = await resolveOnboardingContext(identity, db);
      try {
        await upsertGoatOnboarding(
          {
            userWorkosId: identity.userId,
            workspaceId: context?.workspace.id ?? null,
            role: profile.role,
            building: null,
            companyDomain: companyUrl.hostname,
            contextUrls: [companyUrl.toString()],
          },
          { db },
        );
      } catch (error) {
        logFailure("profile_save", identity, error);
        throw new ApiError(503, "unavailable", "Could not save your profile.", true);
      }
    },

    async saveWorkspace(identity, command) {
      const name = command.name.trim();
      const slug = normalizeWorkspaceSlug(command.slug);
      if (!name) throw new ApiError(400, "invalid_request", "Enter a company name.");
      if (name.length > 80) {
        throw new ApiError(400, "invalid_request", "Name is too long (max 80 chars).");
      }
      if (!slug) throw new ApiError(400, "invalid_request", "Enter a valid workspace URL.");

      try {
        const context = await resolveOnboardingContext(identity, db);
        if (context && context.role !== "admin") {
          throw new ApiError(403, "forbidden", "Only workspace admins can set this up.");
        }
        const available = await isGoatWorkspaceSlugAvailable(
          {
            slug,
            ...(context ? { excludeWorkspaceId: context.workspace.id } : {}),
          },
          { db },
        );
        if (!available) {
          throw new ApiError(409, "conflict", "That workspace URL is taken.");
        }

        if (context) {
          const brain = await activeBrain(identity.userId, context.workspace.id, db);
          if (!brain) {
            throw new ApiError(404, "not_found", "No brain is available for this workspace.");
          }
          const organizationId = await ensureGoatWorkspaceOrganization(context.workspace, {
            workos,
            db,
          });
          await workos.organizations.updateOrganization({ organization: organizationId, name });
          await updateGoatWorkspaceNameAndSlug(
            { workspaceId: context.workspace.id, name, slug },
            { db },
          );
          await upsertGoatOnboarding(
            { userWorkosId: identity.userId, workspaceId: context.workspace.id },
            { db },
          );
          await scaffoldOnboardingFolders(identity.userId, brain.id, db);
          return {
            workspaceId: context.workspace.id,
            organizationId,
            brainId: brain.id,
            createdByCaller: context.workspace.createdByWorkosId === identity.userId,
          };
        }

        if (await hasOwnedGoatHobbyWorkspace(identity.userId, { db })) {
          throw new ApiError(409, "conflict", "Your existing Hobby workspace could not be loaded.");
        }
        const created = await provisionGoatWorkspace(
          {
            authUserId: identity.userId,
            userWorkosId: identity.userId,
            workspaceId: command.workspaceId,
            name,
            slug,
          },
          { workos, db },
        );
        const organizationId = created.workspace.workosOrganizationId;
        if (!organizationId) {
          throw new ApiError(500, "internal_error", "The workspace organization is missing.", true);
        }
        await upsertGoatOnboarding(
          { userWorkosId: identity.userId, workspaceId: created.workspace.id },
          { db },
        );
        await scaffoldOnboardingFolders(identity.userId, created.brain.id, db);
        return {
          workspaceId: created.workspace.id,
          organizationId,
          brainId: created.brain.id,
          createdByCaller: true,
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        logFailure("workspace_save", identity, error);
        throw new ApiError(
          503,
          "unavailable",
          "Could not save your workspace. Please try again.",
          true,
        );
      }
    },

    async finish(identity, rawReferralSource) {
      const context = await resolveOnboardingContext(identity, db);
      if (!context) {
        throw new ApiError(
          409,
          "conflict",
          "Create or join a workspace before finishing onboarding.",
        );
      }
      const referralSource = rawReferralSource?.trim() || null;
      try {
        await upsertGoatOnboarding(
          {
            userWorkosId: identity.userId,
            workspaceId: context.workspace.id,
            referralSource,
          },
          { db },
        );
        await markGoatUserOnboarded(identity.userId, { db });
      } catch (error) {
        logFailure("finish", identity, error);
        throw new ApiError(503, "unavailable", "Could not finish onboarding.", true);
      }
    },
  };
}

async function resolveOnboardingContext(
  identity: ApiIdentity,
  db: DbLike,
): Promise<GoatWorkspaceWithRole | null> {
  const workspaces = await listGoatWorkspacesForUser(identity.userId, { db });
  return (
    workspaces.find(
      (entry) =>
        identity.organizationId && entry.workspace.workosOrganizationId === identity.organizationId,
    ) ??
    workspaces.find((entry) => entry.workspace.id === identity.activeWorkspaceId) ??
    workspaces[0] ??
    null
  );
}

async function activeBrain(userId: string, workspaceId: string, db: DbLike) {
  const brains = await listAccessibleGoatBrains({ userWorkosId: userId, workspaceId }, { db });
  return brains.find((brain) => brain.slug === DEFAULT_GOAT_BRAIN_SLUG) ?? brains[0] ?? null;
}

async function scaffoldOnboardingFolders(userId: string, brainId: string, db: DbLike) {
  const onboarding = await getGoatOnboarding(userId, { db });
  const target = new Set(goatOnboardingFoldersForRole(onboarding?.role));
  const adjustable = new Set<string>(ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS);

  for (const folder of ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS) {
    await reconcileFolder(target.has(folder) ? "create" : "delete", userId, brainId, folder, db);
  }
  for (const folder of target) {
    if (adjustable.has(folder)) continue;
    await reconcileFolder("create", userId, brainId, folder, db);
  }
}

async function reconcileFolder(
  operation: "create" | "delete",
  userId: string,
  brainId: string,
  folder: string,
  db: DbLike,
) {
  try {
    if (operation === "create") {
      await createGoatBrainFolderRow(
        { brainRef: brainId, userWorkosId: userId, path: folder },
        { db },
      );
    } else {
      await deleteGoatBrainFolderRow(
        { brainRef: brainId, userWorkosId: userId, path: folder },
        { db },
      );
    }
  } catch (error) {
    // Folder tailoring was best-effort in the retired action. Keep onboarding
    // available if one optional preset folder cannot be reconciled.
    logger.warn("Onboarding Brain folder reconciliation failed", {
      event: "opencompany.api_onboarding_folder_reconcile_failed",
      operation,
      brain_id: brainId,
      folder,
      error_name: error instanceof Error ? error.name : typeof error,
    });
  }
}

function normalizeWorkspaceSlug(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function logFailure(operation: string, identity: ApiIdentity, error: unknown) {
  logger.error("Onboarding command failed", {
    event: "opencompany.api_onboarding_command_failed",
    operation,
    user_id: identity.userId,
    error_name:
      error instanceof GoatWorkspaceProvisioningError
        ? error.name
        : error instanceof Error
          ? error.name
          : typeof error,
  });
}
