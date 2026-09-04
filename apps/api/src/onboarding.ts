import { onboardingFoldersForRole } from "@opencompany/agent/onboarding-profile";
import { ensureWorkspaceOrganization } from "@opencompany/agent/workspaces/organizations";
import {
  provisionWorkspace,
  WorkspaceProvisioningError,
} from "@opencompany/agent/workspaces/provisioning";
import { ADJUSTABLE_DEFAULT_BRAIN_FOLDERS } from "@opencompany/brain/schema";
import { createBrainFolderRow, deleteBrainFolderRow } from "@opencompany/db/brain-files";
import type { WorkspaceWithRole } from "@opencompany/db/workspaces";
import {
  DEFAULT_BRAIN_SLUG,
  getOnboarding,
  hasOwnedHobbyWorkspace,
  isWorkspaceSlugAvailable,
  listAccessibleBrains,
  listWorkspacesForUser,
  markUserOnboarded,
  updateWorkspaceNameAndSlug,
  upsertOnboarding,
} from "@opencompany/db/workspaces";
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
  brainId: string | null;
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
        getOnboarding(identity.userId, { db }),
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
      const available = await isWorkspaceSlugAvailable(
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
        await upsertOnboarding(
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
        const available = await isWorkspaceSlugAvailable(
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
          if (context.workspace.legacyBrainEnabled && !brain) {
            throw new ApiError(404, "not_found", "No brain is available for this workspace.");
          }
          const organizationId = await ensureWorkspaceOrganization(context.workspace, {
            workos,
            db,
          });
          await workos.organizations.updateOrganization({ organization: organizationId, name });
          await updateWorkspaceNameAndSlug(
            { workspaceId: context.workspace.id, name, slug },
            { db },
          );
          await upsertOnboarding(
            { userWorkosId: identity.userId, workspaceId: context.workspace.id },
            { db },
          );
          if (context.workspace.legacyBrainEnabled && brain) {
            await scaffoldOnboardingFolders(identity.userId, brain.id, db);
          }
          return {
            workspaceId: context.workspace.id,
            organizationId,
            brainId: context.workspace.legacyBrainEnabled ? (brain?.id ?? null) : null,
            createdByCaller: context.workspace.createdByWorkosId === identity.userId,
          };
        }

        if (await hasOwnedHobbyWorkspace(identity.userId, { db })) {
          throw new ApiError(409, "conflict", "Your existing Hobby workspace could not be loaded.");
        }
        const created = await provisionWorkspace(
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
        await upsertOnboarding(
          { userWorkosId: identity.userId, workspaceId: created.workspace.id },
          { db },
        );
        return {
          workspaceId: created.workspace.id,
          organizationId,
          brainId: null,
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
        await upsertOnboarding(
          {
            userWorkosId: identity.userId,
            workspaceId: context.workspace.id,
            referralSource,
          },
          { db },
        );
        await markUserOnboarded(identity.userId, { db });
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
): Promise<WorkspaceWithRole | null> {
  const workspaces = await listWorkspacesForUser(identity.userId, { db });
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
  const brains = await listAccessibleBrains({ userWorkosId: userId, workspaceId }, { db });
  return brains.find((brain) => brain.slug === DEFAULT_BRAIN_SLUG) ?? brains[0] ?? null;
}

async function scaffoldOnboardingFolders(userId: string, brainId: string, db: DbLike) {
  const onboarding = await getOnboarding(userId, { db });
  const target = new Set(onboardingFoldersForRole(onboarding?.role));
  const adjustable = new Set<string>(ADJUSTABLE_DEFAULT_BRAIN_FOLDERS);

  for (const folder of ADJUSTABLE_DEFAULT_BRAIN_FOLDERS) {
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
      await createBrainFolderRow({ brainRef: brainId, userWorkosId: userId, path: folder }, { db });
    } else {
      await deleteBrainFolderRow({ brainRef: brainId, userWorkosId: userId, path: folder }, { db });
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
      error instanceof WorkspaceProvisioningError
        ? error.name
        : error instanceof Error
          ? error.name
          : typeof error,
  });
}
