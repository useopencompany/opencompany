import { ExpiringOAuthReauthRequired } from "@opencompany/agent/integrations/expiring-oauth-access-token";
import {
  GitHubUserAccessAuthError,
  GitHubUserAccessRateLimitError,
  readGitHubUserRepositorySetupFiles,
} from "@opencompany/agent/integrations/github-user";
import {
  collectRepositoryEvidence,
  recommendRepositoryPlugins,
} from "@opencompany/agent/repository-plugin-scan";
import { createLogger } from "@opencompany/observability";
import type { OnboardingRepositoryScan } from "@opencompany/protocol";
import type { ApiIdentity } from "./auth";
import { ApiError } from "./errors";

type DbLike = any;

const logger = createLogger({ service: "opencompany-api", runtime: "onboarding-repository-scan" });

export type OnboardingRepositoryScanService = {
  scan(identity: ApiIdentity, input: { repository?: string }): Promise<OnboardingRepositoryScan>;
};

export function createOnboardingRepositoryScanService(input: {
  db: DbLike;
  apiKey?: string;
  readSetupFiles?: typeof readGitHubUserRepositorySetupFiles;
  recommend?: typeof recommendRepositoryPlugins;
}): OnboardingRepositoryScanService {
  const readSetupFiles = input.readSetupFiles ?? readGitHubUserRepositorySetupFiles;
  const recommend = input.recommend ?? recommendRepositoryPlugins;

  return {
    async scan(identity, command) {
      let setup: Awaited<ReturnType<typeof readGitHubUserRepositorySetupFiles>>;
      try {
        setup = await readSetupFiles({
          userWorkosId: identity.userId,
          db: input.db,
          ...(command.repository ? { repository: command.repository } : {}),
        });
      } catch (error) {
        if (
          error instanceof GitHubUserAccessAuthError ||
          error instanceof ExpiringOAuthReauthRequired
        ) {
          return { status: "not_connected" };
        }
        if (error instanceof GitHubUserAccessRateLimitError) {
          throw new ApiError(
            429,
            "rate_limited",
            "GitHub is rate limiting requests. Try again shortly.",
            true,
          );
        }
        logger.warn("Onboarding repository could not be read", {
          event: "opencompany.api_onboarding_repository_read_failed",
          user_id: identity.userId,
          error_name: error instanceof Error ? error.name : typeof error,
        });
        throw new ApiError(503, "unavailable", "Could not read the repository from GitHub.", true);
      }
      if (!setup) return { status: "no_repositories" };

      const started = Date.now();
      const recommendations = await recommend({
        evidence: collectRepositoryEvidence({ paths: setup.paths, files: setup.files }),
        apiKey: input.apiKey,
      });
      logger.info("Onboarding repository scanned", {
        event: "opencompany.api_onboarding_repository_scanned",
        user_id: identity.userId,
        files_read: setup.files.length,
        plugins: recommendations.plugins.length,
        recommended_by: recommendations.recommendedBy,
        duration_ms: Date.now() - started,
      });
      return {
        status: "scanned",
        repository: setup.repository,
        repositories: setup.repositories,
        plugins: recommendations.plugins,
        recommendedBy: recommendations.recommendedBy,
      };
    },
  };
}
