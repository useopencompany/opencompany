import { ensureWorkspaceOrganization } from "@opencompany/agent/workspaces/organizations";
import {
  provisionWorkspace,
  WorkspaceProvisioningError,
} from "@opencompany/agent/workspaces/provisioning";
import type { WorkspaceWithRole } from "@opencompany/db/workspaces";
import {
  findOwnedHobbyWorkspace,
  getOnboarding,
  isWorkspaceSlugAvailable,
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
};

export type OnboardingWorkspaceView = {
  workspaceId: string;
  organizationId: string;
  createdByCaller: boolean;
};

export type OnboardingService = {
  getState(identity: ApiIdentity): Promise<OnboardingStateView>;
  saveProfile(identity: ApiIdentity, profile: { role: string; companyUrl: string }): Promise<void>;
  saveWorkspace(
    identity: ApiIdentity,
    command: { workspaceId: string; name: string },
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
      };
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
      if (!name) throw new ApiError(400, "invalid_request", "Enter a company name.");
      if (name.length > 80) {
        throw new ApiError(400, "invalid_request", "Name is too long (max 80 chars).");
      }

      try {
        const context = await resolveOnboardingContext(identity, db);
        if (context && context.role !== "admin") {
          throw new ApiError(403, "forbidden", "Only workspace admins can set this up.");
        }
        const slug = await allocateWorkspaceSlug(name, context?.workspace.id ?? null, db);

        if (context) {
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
          return {
            workspaceId: context.workspace.id,
            organizationId,
            createdByCaller: context.workspace.createdByWorkosId === identity.userId,
          };
        }

        if (await findOwnedHobbyWorkspace(identity.userId, { db })) {
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

const WORKSPACE_SLUG_MAX_LENGTH = 40;
const WORKSPACE_SLUG_FALLBACK = "workspace";
const WORKSPACE_SLUG_MAX_ATTEMPTS = 50;

async function allocateWorkspaceSlug(
  name: string,
  excludeWorkspaceId: string | null,
  db: DbLike,
): Promise<string> {
  const base = normalizeWorkspaceSlug(name) || WORKSPACE_SLUG_FALLBACK;
  for (let attempt = 1; attempt <= WORKSPACE_SLUG_MAX_ATTEMPTS; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    // Truncating for the suffix can leave a dangling separator; drop it so the
    // result still reads like a slug.
    const head = base.slice(0, WORKSPACE_SLUG_MAX_LENGTH - suffix.length).replace(/-+$/u, "");
    const available = await isWorkspaceSlugAvailable(
      { slug: `${head}${suffix}`, ...(excludeWorkspaceId ? { excludeWorkspaceId } : {}) },
      { db },
    );
    if (available) return `${head}${suffix}`;
  }
  throw new ApiError(503, "unavailable", "Could not allocate a workspace URL.", true);
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
