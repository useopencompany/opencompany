import type { Actor } from "@opencompany/core";
import {
  createGoatBrain,
  getGoatBrainAccess,
  listGoatBrainMemberIds,
  listGoatWorkspaceMembers,
  replaceGoatBrainMembers,
  updateGoatBrainVisibility,
} from "@opencompany/db/goat-workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrainControlService } from "./brain-control";

vi.mock("@opencompany/db/goat-workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createGoatBrain: vi.fn(async () => ({ id: "brain_new" })),
  getGoatBrainAccess: vi.fn(),
  listGoatBrainMemberIds: vi.fn(async () => ["user_1"]),
  listGoatWorkspaceMembers: vi.fn(),
  replaceGoatBrainMembers: vi.fn(async () => undefined),
  updateGoatBrainEnrichmentEnabled: vi.fn(async () => undefined),
  updateGoatBrainIntelligence: vi.fn(async () => undefined),
  updateGoatBrainVisibility: vi.fn(async () => undefined),
}));

const admin: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: [],
  authenticationMethod: "session",
};
const member: Actor = { ...admin, role: "member" };
const db = { sentinel: true } as never;

describe("Brain control service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoatBrainAccess).mockResolvedValue(brainAccess() as never);
    vi.mocked(listGoatWorkspaceMembers).mockResolvedValue(workspaceMembers() as never);
  });

  it("authorizes a Brain switch against the actor's active workspace", async () => {
    const service = createBrainControlService({ db });
    await expect(service.switchBrain(member, "brain_1")).resolves.toEqual({ brainId: "brain_1" });
    expect(getGoatBrainAccess).toHaveBeenCalledWith(
      { userWorkosId: "user_1", brainRef: "brain_1" },
      { db },
    );

    vi.mocked(getGoatBrainAccess).mockResolvedValueOnce(
      brainAccess({ workspaceId: "workspace_other" }) as never,
    );
    await expect(service.switchBrain(member, "brain_1")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("requires admin authorization for Brain creation", async () => {
    const service = createBrainControlService({ db });
    await expect(
      service.createBrain(member, { name: "Research", visibility: "workspace" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.createBrain(admin, { name: "Research", visibility: "workspace" }),
    ).resolves.toEqual({ brainId: "brain_new" });
    expect(createGoatBrain).toHaveBeenCalledWith(
      {
        workspaceId: "workspace_1",
        name: "Research",
        visibility: "workspace",
        description: null,
        createdByWorkosId: "user_1",
      },
      { db },
    );
  });

  it("rejects restricted-Brain members from outside the workspace", async () => {
    const service = createBrainControlService({ db });
    await expect(
      service.setAccess(admin, "brain_1", {
        visibility: "restricted",
        memberIds: ["user_outside"],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(updateGoatBrainVisibility).not.toHaveBeenCalled();
  });

  it("keeps the acting admin in a restricted Brain and exposes member-safe DTOs", async () => {
    const service = createBrainControlService({ db });
    await service.setAccess(admin, "brain_1", {
      visibility: "restricted",
      memberIds: ["user_2"],
    });
    expect(replaceGoatBrainMembers).toHaveBeenCalledWith(
      {
        brainRef: "brain_1",
        userWorkosIds: ["user_2", "user_1"],
        addedByWorkosId: "user_1",
      },
      { db },
    );

    await expect(service.getAccess(admin, "brain_1")).resolves.toEqual({
      visibility: "workspace",
      memberIds: ["user_1"],
      workspaceMembers: [
        {
          id: "user_1",
          email: "ada@example.com",
          name: "Ada Lovelace",
          avatarUrl: null,
          role: "admin",
        },
        {
          id: "user_2",
          email: "grace@example.com",
          name: "grace@example.com",
          avatarUrl: null,
          role: "member",
        },
      ],
    });
    expect(listGoatBrainMemberIds).toHaveBeenCalledWith("brain_1", { db });
  });
});

function brainAccess(overrides: Record<string, unknown> = {}) {
  return {
    brain: {
      id: "brain_1",
      workspaceId: "workspace_1",
      visibility: "workspace",
      enrichmentEnabled: true,
      intelligence: "basic",
      ...overrides,
    },
    workspaceRole: "admin",
  };
}

function workspaceMembers() {
  return [
    {
      member: { role: "admin" },
      user: {
        workosUserId: "user_1",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
      },
    },
    {
      member: { role: "member" },
      user: {
        workosUserId: "user_2",
        email: "grace@example.com",
        firstName: null,
        lastName: null,
        avatarUrl: null,
      },
    },
  ];
}
