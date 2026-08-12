import { describe, expect, it, vi } from "vitest";
import { CoreError } from "./chat";
import {
  SkillImportApplicationService,
  type SkillImportRepository,
  type SkillImportResolver,
} from "./skill-import";

const actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["skill:write"],
  authenticationMethod: "session" as const,
};
const resolvedCommit = "a".repeat(40);
const integrity = `sha256:${"b".repeat(64)}`;
const resolved = {
  status: "resolved" as const,
  proposedSlug: "my-skill",
  name: "My Skill",
  description: "Does things.",
  instructions: "Do the thing.",
  source: {
    type: "github" as const,
    url: "https://github.com/o/r",
    ref: "main",
    path: "",
  },
  resolvedCommit,
  integrity,
  extraFiles: [] as string[],
};

describe("SkillImportApplicationService", () => {
  it("requires Skill write permission before resolving an external source", async () => {
    const resolver = { resolve: vi.fn() } satisfies SkillImportResolver;
    const service = new SkillImportApplicationService(repository(), resolver);

    await expect(
      service.preview({ ...actor, permissions: [] }, { url: "github.com/o/r" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("binds persistence to the exact previewed commit and integrity", async () => {
    const importSkill = vi.fn(async () => ({ skill: {} as never, idempotentReplay: false }));
    const service = new SkillImportApplicationService(repository({ importSkill }), {
      resolve: vi.fn(async () => resolved),
    });

    await service.import(actor, {
      idempotencyKey: "skill-import-1",
      url: "github.com/o/r",
      expectedResolvedCommit: resolvedCommit,
      expectedIntegrity: integrity,
    });

    expect(importSkill).toHaveBeenCalledWith({
      actor,
      idempotencyKey: "skill-import-1",
      name: "My Skill",
      description: "Does things.",
      instructions: "Do the thing.",
      source: resolved.source,
      resolvedCommit,
      integrity,
    });
  });

  it("rejects changed content before persistence", async () => {
    const importSkill = vi.fn();
    const service = new SkillImportApplicationService(repository({ importSkill }), {
      resolve: vi.fn(async () => resolved),
    });

    await expect(
      service.import(actor, {
        idempotencyKey: "skill-import-1",
        url: "github.com/o/r",
        expectedResolvedCommit: "c".repeat(40),
        expectedIntegrity: integrity,
      }),
    ).rejects.toEqual(
      new CoreError(
        "conflict",
        "This skill changed since the preview. Preview it again before importing.",
      ),
    );
    expect(importSkill).not.toHaveBeenCalled();
  });
});

function repository(overrides: Partial<SkillImportRepository> = {}): SkillImportRepository {
  return {
    importSkill: vi.fn(async () => ({ skill: {} as never, idempotentReplay: false })),
    ...overrides,
  };
}
