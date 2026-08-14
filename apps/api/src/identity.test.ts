import { ensureWorkspaceOrganizationsForEntries } from "@opencompany/agent/workspaces/organizations";
import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import { syncStripeSeatQuantityForWorkspace } from "@opencompany/billing/seats";
import {
  adoptWorkspaceMembershipsFromOrgs,
  listAccessibleBrains,
  listWorkspacesForUser,
} from "@opencompany/db/workspaces";
import { recordSignup } from "@opencompany/telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityService } from "./identity";

vi.mock("@opencompany/analytics/product/server", () => ({ captureProductServerEvent: vi.fn() }));
vi.mock("@opencompany/billing/seats", () => ({
  syncStripeSeatQuantityForWorkspace: vi.fn(),
}));
vi.mock("@opencompany/db/workspaces", () => ({
  adoptWorkspaceMembershipsFromOrgs: vi.fn(),
  DEFAULT_BRAIN_SLUG: "general",
  listAccessibleBrains: vi.fn(),
  listWorkspacesForUser: vi.fn(),
}));
vi.mock("@opencompany/agent/workspaces/organizations", () => ({
  ensureWorkspaceOrganizationsForEntries: vi.fn(),
}));
vi.mock("@opencompany/telemetry", () => ({ recordSignup: vi.fn() }));

const now = new Date("2026-08-13T12:00:00.000Z");
const authUser = {
  id: "user_1",
  email: "owner@example.com",
  firstName: "Owner",
  lastName: "Example",
  profilePictureUrl: null,
};
const localUser = {
  workosUserId: authUser.id,
  email: authUser.email,
  firstName: authUser.firstName,
  lastName: authUser.lastName,
  avatarUrl: null,
  timezone: "UTC",
  taskSpawningEnabled: true,
  autoModelRoutingEnabled: false,
  chatCapabilitiesBetaEnabled: false,
  imessageEnabled: false,
  wikiEnabled: true,
  taskViewMode: "board",
  preferredMcpClient: null,
  mcpSetupCompletedAt: null,
  onboardedAt: now,
  createdAt: now,
  updatedAt: now,
};
const identity = {
  userId: authUser.id,
  organizationId: "org_company",
  activeWorkspaceId: null,
  activeBrainId: null,
  method: "session" as const,
};

function dbWith(input: { selected?: unknown[]; inserted?: unknown[]; updated?: unknown[] }) {
  const limit = vi.fn(async () => input.selected ?? []);
  const selectWhere = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));
  const insertReturning = vi.fn(async () => input.inserted ?? []);
  const onConflictDoNothing = vi.fn(() => ({ returning: insertReturning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  const updateReturning = vi.fn(async () => input.updated ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  return { select, insert, update };
}

describe("identity service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listWorkspacesForUser).mockResolvedValue([
      {
        workspace: {
          id: "goat_ws_company",
          workosOrganizationId: "org_company",
          name: "Company",
          slug: "company",
        },
        role: "admin",
      },
    ] as never);
    vi.mocked(ensureWorkspaceOrganizationsForEntries).mockImplementation(
      async (entries) => entries,
    );
    vi.mocked(listAccessibleBrains).mockResolvedValue([
      {
        id: "brain_general",
        workspaceId: "goat_ws_company",
        name: "General",
        slug: "general",
        description: null,
        visibility: "workspace",
        enrichmentEnabled: true,
        intelligence: "basic",
      },
    ] as never);
  });

  it("synchronizes the verified WorkOS profile and returns only the authorized identity view", async () => {
    const db = dbWith({ inserted: [localUser] });
    const getUser = vi.fn(async () => authUser);
    const listOrganizationMemberships = vi.fn(async () => ({
      data: [{ organizationId: "org_company", role: { slug: "admin" } }],
    }));
    vi.mocked(adoptWorkspaceMembershipsFromOrgs).mockResolvedValue(0);
    const service = createIdentityService({
      db,
      workos: { userManagement: { getUser, listOrganizationMemberships } } as never,
    });

    const result = await service.sync(identity);

    expect(result).toMatchObject({
      user: { id: authUser.id, email: authUser.email },
      activeWorkspaceId: "goat_ws_company",
      activeBrainId: "brain_general",
    });
    expect(result.user).not.toHaveProperty("workosUserId");
    expect(result.workspaces[0]).not.toHaveProperty("workosOrganizationId");
    expect(recordSignup).toHaveBeenCalledWith({ source: "user_sync" });
    expect(captureProductServerEvent).toHaveBeenCalledOnce();
    expect(adoptWorkspaceMembershipsFromOrgs).toHaveBeenCalledWith(
      {
        userWorkosId: authUser.id,
        memberships: [{ organizationId: "org_company", role: "admin" }],
      },
      { db },
    );
  });

  it("retries membership adoption on a workspace-free identity read without blocking sign-in", async () => {
    const db = dbWith({ selected: [localUser] });
    vi.mocked(listWorkspacesForUser).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const membershipError = new Error("WorkOS unavailable");
    const service = createIdentityService({
      db,
      workos: {
        userManagement: {
          getUser: vi.fn(),
          listOrganizationMemberships: vi.fn(async () => {
            throw membershipError;
          }),
        },
      } as never,
    });

    await expect(service.get(identity)).resolves.toMatchObject({
      workspaces: [],
      activeWorkspaceId: null,
      brains: [],
    });
    expect(syncStripeSeatQuantityForWorkspace).not.toHaveBeenCalled();
  });
});
