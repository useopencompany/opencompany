import {
  createGoatBrainFolderRow,
  deleteGoatBrainFolderRow,
} from "@opencompany/db/goat-brain-files";
import {
  getGoatOnboarding,
  hasOwnedGoatHobbyWorkspace,
  isGoatWorkspaceSlugAvailable,
  listAccessibleGoatBrains,
  listGoatWorkspacesForUser,
  markGoatUserOnboarded,
  updateGoatWorkspaceNameAndSlug,
  upsertGoatOnboarding,
} from "@opencompany/db/goat-workspaces";
import { ensureGoatWorkspaceOrganization } from "@opencompany/goat-agent/workspaces/organizations";
import { provisionGoatWorkspace } from "@opencompany/goat-agent/workspaces/provisioning";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiIdentity } from "./auth";
import { createOnboardingService } from "./onboarding";

vi.mock("@opencompany/db/goat-brain-files", () => ({
  createGoatBrainFolderRow: vi.fn(async () => undefined),
  deleteGoatBrainFolderRow: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/goat-workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGoatOnboarding: vi.fn(),
  hasOwnedGoatHobbyWorkspace: vi.fn(async () => false),
  isGoatWorkspaceSlugAvailable: vi.fn(async () => true),
  listAccessibleGoatBrains: vi.fn(),
  listGoatWorkspacesForUser: vi.fn(),
  markGoatUserOnboarded: vi.fn(async () => undefined),
  updateGoatWorkspaceNameAndSlug: vi.fn(async () => undefined),
  upsertGoatOnboarding: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/goat-agent/workspaces/organizations", () => ({
  ensureGoatWorkspaceOrganization: vi.fn(async () => "org_current"),
}));

vi.mock("@opencompany/goat-agent/workspaces/provisioning", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  provisionGoatWorkspace: vi.fn(),
}));

const identity: ApiIdentity = {
  userId: "user_1",
  organizationId: null,
  activeWorkspaceId: null,
  method: "session",
};

const workspace = {
  id: "goat_ws_current",
  name: "Current Organization",
  slug: "current-organization",
  workosOrganizationId: "org_current",
  createdByWorkosId: "user_1",
};

const workos = {
  organizations: {
    updateOrganization: vi.fn(async () => ({ id: "org_current" })),
  },
};

describe("onboarding service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoatOnboarding).mockResolvedValue({ role: "founder" } as never);
    vi.mocked(hasOwnedGoatHobbyWorkspace).mockResolvedValue(false);
    vi.mocked(isGoatWorkspaceSlugAvailable).mockResolvedValue(true);
    vi.mocked(listGoatWorkspacesForUser).mockResolvedValue([] as never);
    vi.mocked(listAccessibleGoatBrains).mockResolvedValue([
      { id: "brain_general", slug: "general" },
    ] as never);
    vi.mocked(provisionGoatWorkspace).mockResolvedValue({
      workspace: {
        ...workspace,
        id: "goat_ws_new",
        workosOrganizationId: "org_new",
      },
      brain: { id: "brain_new" },
    } as never);
  });

  it("persists a validated profile before the identity has an actor context", async () => {
    const service = createOnboardingService({ db: {}, workos: workos as never });
    await service.saveProfile(identity, {
      role: "founder",
      companyUrl: "https://opencompany.ai/",
    });
    expect(upsertGoatOnboarding).toHaveBeenCalledWith(
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
      brainId: "brain_new",
      createdByCaller: true,
    });
    expect(provisionGoatWorkspace).toHaveBeenCalledWith(
      {
        authUserId: "user_1",
        userWorkosId: "user_1",
        workspaceId: "goat_ws_new",
        name: "Analytical Co",
        slug: "analytical-co",
      },
      { db, workos },
    );
    expect(upsertGoatOnboarding).toHaveBeenCalledWith(
      { userWorkosId: "user_1", workspaceId: "goat_ws_new" },
      { db },
    );
  });

  it("authorizes an existing workspace before renaming its WorkOS organization", async () => {
    vi.mocked(listGoatWorkspacesForUser).mockResolvedValue([
      { workspace, role: "member" },
    ] as never);
    const service = createOnboardingService({ db: {}, workos: workos as never });
    await expect(
      service.saveWorkspace(identity, {
        workspaceId: "goat_ws_ignored",
        name: "Renamed",
        slug: "renamed",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(ensureGoatWorkspaceOrganization).not.toHaveBeenCalled();
    expect(workos.organizations.updateOrganization).not.toHaveBeenCalled();
    expect(updateGoatWorkspaceNameAndSlug).not.toHaveBeenCalled();
  });

  it("updates an authorized existing workspace and returns activation resources", async () => {
    const db = {};
    vi.mocked(listGoatWorkspacesForUser).mockResolvedValue([{ workspace, role: "admin" }] as never);
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
      brainId: "brain_general",
      createdByCaller: true,
    });
    expect(workos.organizations.updateOrganization).toHaveBeenCalledWith({
      organization: "org_current",
      name: "Renamed",
    });
    expect(updateGoatWorkspaceNameAndSlug).toHaveBeenCalledWith(
      { workspaceId: "goat_ws_current", name: "Renamed", slug: "renamed" },
      { db },
    );
  });

  it("finishes only after resolving an accessible workspace", async () => {
    const db = {};
    const service = createOnboardingService({ db, workos: workos as never });
    await expect(service.finish(identity, "friend")).rejects.toMatchObject({ status: 409 });

    vi.mocked(listGoatWorkspacesForUser).mockResolvedValue([{ workspace, role: "admin" }] as never);
    await service.finish(identity, " friend ");
    expect(upsertGoatOnboarding).toHaveBeenCalledWith(
      {
        userWorkosId: "user_1",
        workspaceId: "goat_ws_current",
        referralSource: "friend",
      },
      { db },
    );
    expect(markGoatUserOnboarded).toHaveBeenCalledWith("user_1", { db });
  });

  it("keeps optional Brain folder tailoring from blocking onboarding", async () => {
    vi.mocked(createGoatBrainFolderRow).mockRejectedValueOnce(new Error("folder conflict"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = createOnboardingService({ db: {}, workos: workos as never });
    await expect(
      service.saveWorkspace(identity, {
        workspaceId: "goat_ws_new",
        name: "Analytical Co",
        slug: "analytical-co",
      }),
    ).resolves.toMatchObject({ workspaceId: "goat_ws_new" });
    expect(deleteGoatBrainFolderRow).toHaveBeenCalled();
    warning.mockRestore();
  });
});
