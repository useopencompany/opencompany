import { ensureWorkspaceOrganization } from "@opencompany/agent/workspaces/organizations";
import { provisionWorkspace } from "@opencompany/agent/workspaces/provisioning";
import { createBrainFolderRow, deleteBrainFolderRow } from "@opencompany/db/brain-files";
import {
  getOnboarding,
  hasOwnedHobbyWorkspace,
  isWorkspaceSlugAvailable,
  listAccessibleBrains,
  listWorkspacesForUser,
  markUserOnboarded,
  updateWorkspaceNameAndSlug,
  upsertOnboarding,
} from "@opencompany/db/workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiIdentity } from "./auth";
import { createOnboardingService } from "./onboarding";

vi.mock("@opencompany/db/brain-files", () => ({
  createBrainFolderRow: vi.fn(async () => undefined),
  deleteBrainFolderRow: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOnboarding: vi.fn(),
  hasOwnedHobbyWorkspace: vi.fn(async () => false),
  isWorkspaceSlugAvailable: vi.fn(async () => true),
  listAccessibleBrains: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  markUserOnboarded: vi.fn(async () => undefined),
  updateWorkspaceNameAndSlug: vi.fn(async () => undefined),
  upsertOnboarding: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/agent/workspaces/organizations", () => ({
  ensureWorkspaceOrganization: vi.fn(async () => "org_current"),
}));

vi.mock("@opencompany/agent/workspaces/provisioning", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  provisionWorkspace: vi.fn(),
}));

const identity: ApiIdentity = {
  userId: "user_1",
  organizationId: null,
  activeWorkspaceId: null,
  activeBrainId: null,
  method: "session",
  credentialKind: "browser_cookie",
};

const workspace = {
  id: "goat_ws_current",
  name: "Current Organization",
  slug: "current-organization",
  workosOrganizationId: "org_current",
  createdByWorkosId: "user_1",
  legacyBrainEnabled: false,
};

const workos = {
  organizations: {
    updateOrganization: vi.fn(async () => ({ id: "org_current" })),
  },
};

describe("onboarding service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOnboarding).mockResolvedValue({ role: "founder" } as never);
    vi.mocked(hasOwnedHobbyWorkspace).mockResolvedValue(false);
    vi.mocked(isWorkspaceSlugAvailable).mockResolvedValue(true);
    vi.mocked(listWorkspacesForUser).mockResolvedValue([] as never);
    vi.mocked(listAccessibleBrains).mockResolvedValue([
      { id: "brain_general", slug: "general" },
    ] as never);
    vi.mocked(provisionWorkspace).mockResolvedValue({
      workspace: {
        ...workspace,
        id: "goat_ws_new",
        workosOrganizationId: "org_new",
      },
      brain: null,
    } as never);
  });

  it("persists a validated profile before the identity has an actor context", async () => {
    const service = createOnboardingService({ db: {}, workos: workos as never });
    await service.saveProfile(identity, {
      role: "founder",
      companyUrl: "https://opencompany.ai/",
    });
    expect(upsertOnboarding).toHaveBeenCalledWith(
      {
        userWorkosId: "user_1",
        workspaceId: null,
        role: "founder",
        building: null,
        companyDomain: "opencompany.ai",
        contextUrls: ["https://opencompany.ai/"],
      },
      { db: {} },
    );
  });

  it("provisions the first workspace idempotently by the caller workspace id", async () => {
    const db = {};
    const service = createOnboardingService({ db, workos: workos as never });
    await expect(
      service.saveWorkspace(identity, {
        workspaceId: "goat_ws_new",
        name: " Analytical Co ",
        slug: "Analytical Co",
      }),
    ).resolves.toEqual({
      workspaceId: "goat_ws_new",
      organizationId: "org_new",
      brainId: null,
      createdByCaller: true,
    });
    expect(provisionWorkspace).toHaveBeenCalledWith(
      {
        authUserId: "user_1",
        userWorkosId: "user_1",
        workspaceId: "goat_ws_new",
        name: "Analytical Co",
        slug: "analytical-co",
      },
      { db, workos },
    );
    expect(upsertOnboarding).toHaveBeenCalledWith(
      { userWorkosId: "user_1", workspaceId: "goat_ws_new" },
      { db },
    );
  });

  it("authorizes an existing workspace before renaming its WorkOS organization", async () => {
    vi.mocked(listWorkspacesForUser).mockResolvedValue([{ workspace, role: "member" }] as never);
    const service = createOnboardingService({ db: {}, workos: workos as never });
    await expect(
      service.saveWorkspace(identity, {
        workspaceId: "goat_ws_ignored",
        name: "Renamed",
        slug: "renamed",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(ensureWorkspaceOrganization).not.toHaveBeenCalled();
    expect(workos.organizations.updateOrganization).not.toHaveBeenCalled();
    expect(updateWorkspaceNameAndSlug).not.toHaveBeenCalled();
  });

  it("updates an authorized existing workspace and returns activation resources", async () => {
    const db = {};
    vi.mocked(listWorkspacesForUser).mockResolvedValue([{ workspace, role: "admin" }] as never);
    const service = createOnboardingService({ db, workos: workos as never });
    await expect(
      service.saveWorkspace(identity, {
        workspaceId: "goat_ws_ignored",
        name: "Renamed",
        slug: "renamed",
      }),
    ).resolves.toEqual({
      workspaceId: "goat_ws_current",
      organizationId: "org_current",
      brainId: null,
      createdByCaller: true,
    });
    expect(workos.organizations.updateOrganization).toHaveBeenCalledWith({
      organization: "org_current",
      name: "Renamed",
    });
    expect(updateWorkspaceNameAndSlug).toHaveBeenCalledWith(
      { workspaceId: "goat_ws_current", name: "Renamed", slug: "renamed" },
      { db },
    );
  });

  it("finishes only after resolving an accessible workspace", async () => {
    const db = {};
    const service = createOnboardingService({ db, workos: workos as never });
    await expect(service.finish(identity, "friend")).rejects.toMatchObject({ status: 409 });

    vi.mocked(listWorkspacesForUser).mockResolvedValue([{ workspace, role: "admin" }] as never);
    await service.finish(identity, " friend ");
    expect(upsertOnboarding).toHaveBeenCalledWith(
      {
        userWorkosId: "user_1",
        workspaceId: "goat_ws_current",
        referralSource: "friend",
      },
      { db },
    );
    expect(markUserOnboarded).toHaveBeenCalledWith("user_1", { db });
  });

  it("keeps optional Brain folder tailoring for an existing legacy workspace", async () => {
    vi.mocked(listWorkspacesForUser).mockResolvedValue([
      { workspace: { ...workspace, legacyBrainEnabled: true }, role: "admin" },
    ] as never);
    vi.mocked(createBrainFolderRow).mockRejectedValueOnce(new Error("folder conflict"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = createOnboardingService({ db: {}, workos: workos as never });
    await expect(
      service.saveWorkspace(identity, {
        workspaceId: "goat_ws_ignored",
        name: "Analytical Co",
        slug: "analytical-co",
      }),
    ).resolves.toMatchObject({ workspaceId: "goat_ws_current", brainId: "brain_general" });
    expect(deleteBrainFolderRow).toHaveBeenCalled();
    warning.mockRestore();
  });
});
