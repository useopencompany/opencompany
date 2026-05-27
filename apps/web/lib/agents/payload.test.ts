import { describe, expect, it } from "vitest";
import { buildGitHubRepositoryCatalogs, type GitHubIntegrationRepositoryPayload } from "./payload";

const binding = {
  provider: "github" as const,
  resourceType: "repository" as const,
  externalId: "repo_123",
  displayName: "opencompany/web",
  connection: {
    externalId: "install_123",
    label: "OpenCompany",
    accountName: "opencompany",
    accountType: "Organization",
  },
};

describe("buildGitHubRepositoryCatalogs", () => {
  it("keeps unavailable resources out of the usable mention catalog", () => {
    const unavailableRepository: GitHubIntegrationRepositoryPayload = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "permission_lost",
      statusReason: "Repository is no longer visible.",
      connectionStatus: "connected",
      binding,
    };

    const catalogs = buildGitHubRepositoryCatalogs({
      repositories: [unavailableRepository],
    });

    expect(catalogs.usableRepositories).toEqual([]);
    expect(catalogs.derivationRepositories).toEqual([]);
  });

  it("preserves a saved stale repository for derivation but not new mentions", () => {
    const catalogs = buildGitHubRepositoryCatalogs({
      repositories: [],
      savedRepositories: [
        {
          id: "opencompany-web",
          fullName: "opencompany/web",
          defaultBranch: "main",
          binding,
        },
      ],
    });

    expect(catalogs.usableRepositories).toEqual([]);
    expect(catalogs.derivationRepositories).toEqual([
      {
        fullName: "opencompany/web",
        defaultBranch: "main",
        binding,
      },
    ]);
  });

  it("uses available connected resources for both catalogs", () => {
    const availableRepository: GitHubIntegrationRepositoryPayload = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "available",
      statusReason: null,
      connectionStatus: "connected",
      binding,
    };

    const catalogs = buildGitHubRepositoryCatalogs({
      repositories: [availableRepository],
    });

    expect(catalogs.usableRepositories).toEqual([availableRepository]);
    expect(catalogs.derivationRepositories).toEqual([availableRepository]);
  });

  it("keeps legacy saved references separate from fresh usable bindings", () => {
    const availableRepository: GitHubIntegrationRepositoryPayload = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "available",
      statusReason: null,
      connectionStatus: "connected",
      binding,
    };

    const catalogs = buildGitHubRepositoryCatalogs({
      repositories: [availableRepository],
      savedRepositories: [
        {
          id: "opencompany-web",
          fullName: "opencompany/web",
          defaultBranch: "main",
        },
      ],
    });

    expect(catalogs.derivationRepositories).toEqual([
      availableRepository,
      {
        fullName: "opencompany/web",
        defaultBranch: "main",
      },
    ]);
  });

  it("keeps same-name repositories from different GitHub connections by binding identity", () => {
    const secondBinding = {
      ...binding,
      externalId: "repo_456",
      connection: {
        ...binding.connection,
        externalId: "install_456",
        label: "OpenCompany EU",
      },
    };
    const firstRepository: GitHubIntegrationRepositoryPayload = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "available",
      statusReason: null,
      connectionStatus: "connected",
      binding,
    };
    const secondRepository: GitHubIntegrationRepositoryPayload = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "available",
      statusReason: null,
      connectionStatus: "connected",
      binding: secondBinding,
    };

    const catalogs = buildGitHubRepositoryCatalogs({
      repositories: [firstRepository, secondRepository],
      savedRepositories: [
        {
          id: "opencompany-web",
          fullName: "opencompany/web",
          defaultBranch: "main",
        },
      ],
    });

    expect(catalogs.usableRepositories).toEqual([firstRepository, secondRepository]);
    expect(catalogs.derivationRepositories).toEqual([
      firstRepository,
      secondRepository,
      {
        fullName: "opencompany/web",
        defaultBranch: "main",
      },
    ]);
  });
});
