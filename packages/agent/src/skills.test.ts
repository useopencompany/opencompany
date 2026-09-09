import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeWorkspaceSkillToolForActor,
  manageWorkspaceSkillsForActor,
  readSkillMentionRefs,
} from "./skills";

const repository = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  install: vi.fn(),
  replace: vi.fn(),
  archive: vi.fn(),
}));
vi.mock("@opencompany/db/skill-bundle-repository", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  PostgresSkillBundleRepository: class {
    constructor() {
      return repository;
    }
  },
}));

const actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["skill:read", "skill:write"],
  authenticationMethod: "service" as const,
};
const installation = {
  id: "skill_installation_1",
  scope: "personal",
  createdByUserId: "user_1",
  canEdit: true,
  canManage: true,
  name: "my-skill",
  enabled: false,
  bundle: {
    id: "latest_bundle",
    description: "Current description.",
    body: "Current saved instructions.",
    source: { type: "workspace" },
  },
};
const db = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  repository.list.mockResolvedValue([installation]);
  repository.get.mockResolvedValue(installation);
  repository.install.mockResolvedValue({ installation, idempotentReplay: false });
  repository.replace.mockResolvedValue(installation);
});

describe("workspace Skill management", () => {
  it("retains stable installation IDs and legacy names in engine mentions", () => {
    expect(
      readSkillMentionRefs([
        { kind: "skill", id: "skill_installation_abc123" },
        { kind: "skill", id: "legacy-name" },
      ]),
    ).toEqual({ ok: true, mentions: [{ id: "skill_installation_abc123" }, { id: "legacy-name" }] });
  });

  it("lists disabled installations and reads their current saved instructions without activation", async () => {
    await expect(manageWorkspaceSkillsForActor({ actor, command: "list", db })).resolves.toEqual({
      skills: [
        {
          id: "skill_installation_1",
          scope: "personal",
          createdByUserId: "user_1",
          canManage: true,
          name: "my-skill",
          description: "Current description.",
          enabled: false,
          source: "workspace",
          editable: true,
        },
      ],
    });
    await expect(
      manageWorkspaceSkillsForActor({ actor, command: "read", name: "my-skill", db }),
    ).resolves.toMatchObject({
      instructions: "Current saved instructions.",
      bundleId: "latest_bundle",
      enabled: false,
    });
    expect(repository.get).toHaveBeenCalledWith({ actor, name: "my-skill" });
  });

  it("marks imported Skills as non-editable and archives only the named workspace installation", async () => {
    repository.list.mockResolvedValue([
      { ...installation, bundle: { ...installation.bundle, source: { type: "github" } } },
    ]);
    await expect(
      manageWorkspaceSkillsForActor({ actor, command: "list", db }),
    ).resolves.toMatchObject({ skills: [{ editable: false }] });
    await expect(
      manageWorkspaceSkillsForActor({ actor, command: "archive", name: "my-skill", db }),
    ).resolves.toEqual({ archived: true, name: "my-skill" });
    expect(repository.archive).toHaveBeenCalledWith({ actor, name: "my-skill" });
  });

  it("rejects missing names, unsupported commands, and writes without permission", async () => {
    await expect(
      manageWorkspaceSkillsForActor({ actor, command: "archive", db }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      manageWorkspaceSkillsForActor({ actor, command: "delete", name: "my-skill", db }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      manageWorkspaceSkillsForActor({
        actor: { ...actor, role: "member", permissions: ["skill:read"] },
        command: "archive",
        name: "my-skill",
        db,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(repository.archive).not.toHaveBeenCalled();
  });

  it("routes engine authoring through canonical validation and passes the expected version", async () => {
    const args = {
      name: "my-skill",
      description: "Does work.",
      instructions: "# Steps\nDo the work.",
    };
    await executeWorkspaceSkillToolForActor({
      actor,
      tool: "create_workspace_skill",
      args,
      idempotencyKey: "call_1",
      db,
    });
    expect(repository.install).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        idempotencyKey: "call_1",
        bundle: expect.objectContaining({ source: { type: "workspace" }, name: "my-skill" }),
      }),
    );
    await executeWorkspaceSkillToolForActor({
      actor,
      tool: "edit_workspace_skill",
      args: { ...args, expectedBundleId: "previous_bundle" },
      idempotencyKey: "call_2",
      db,
    });
    expect(repository.replace).toHaveBeenCalledWith(
      expect.objectContaining({ actor, name: "my-skill", expectedBundleId: "previous_bundle" }),
    );
    await expect(
      executeWorkspaceSkillToolForActor({
        actor,
        tool: "edit_workspace_skill",
        args: { ...args, instructions: "" },
        idempotencyKey: "call_3",
        db,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
});
