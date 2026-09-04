import { describe, expect, it, vi } from "vitest";
import { CoreError } from "./chat";
import {
  createSkillFileChunk,
  type SkillBundleAuthor,
  type SkillBundleRepository,
  SkillImportApplicationService,
  type SkillImportResolver,
} from "./skill-import";

const unexpectedAuthor: SkillBundleAuthor = {
  create: async () => {
    throw new Error("Unexpected workspace Skill authoring operation.");
  },
};

const actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["skill:read", "skill:write"],
  authenticationMethod: "session" as const,
};
const resolvedCommit = "a".repeat(40);
const integrity = `sha256:${"b".repeat(64)}`;
const source = {
  type: "github" as const,
  url: "https://github.com/o/r",
  ref: "main",
  path: "my-skill",
  resolvedCommit,
};
const files = [
  {
    path: "SKILL.md",
    content: new TextEncoder().encode("private bytes"),
    executable: false,
  },
];
const resolved = {
  status: "resolved" as const,
  warnings: [
    {
      code: "source_directory_normalized" as const,
      message: "Source directory normalized.",
    },
  ],
  bundle: {
    name: "my-skill",
    description: "Does things.",
    body: "Do the thing.",
    source,
    integrity,
    files,
    fileCount: 1,
    totalBytes: files[0]!.content.length,
  },
};

describe("SkillImportApplicationService", () => {
  it("authors workspace Skills through the same immutable install and replacement boundaries", async () => {
    const install = vi.fn(async () => ({ installation: {} as never, idempotentReplay: false }));
    const replace = vi.fn(async () => ({}) as never);
    const create = vi.fn(
      async (input: { name: string; description: string; instructions: string }) => ({
        name: input.name,
        description: input.description,
        body: input.instructions,
        source: { type: "workspace" as const },
        integrity,
        files,
        fileCount: 1,
        totalBytes: files[0]!.content.length,
      }),
    );
    const service = new SkillImportApplicationService(
      repository({ install, replace }),
      { resolve: vi.fn() },
      { create },
    );

    await service.create(actor, {
      idempotencyKey: "workspace-skill-1",
      name: "investigate-bug",
      description: "Reproduce and diagnose bugs.",
      instructions: "Reproduce first.",
    });
    await service.update(actor, "investigate-bug", {
      description: "Reproduce and diagnose bugs.",
      instructions: "Reproduce, isolate, and explain.",
    });

    expect(create).toHaveBeenNthCalledWith(1, {
      name: "investigate-bug",
      description: "Reproduce and diagnose bugs.",
      instructions: "Reproduce first.",
    });
    expect(install).toHaveBeenCalledWith({
      actor,
      idempotencyKey: "workspace-skill-1",
      bundle: expect.objectContaining({ name: "investigate-bug", source: { type: "workspace" } }),
    });
    expect(replace).toHaveBeenCalledWith({
      actor,
      name: "investigate-bug",
      bundle: expect.objectContaining({
        name: "investigate-bug",
        body: "Reproduce, isolate, and explain.",
      }),
    });
  });

  it("requires Skill write permission before resolving an external source", async () => {
    const resolver = { resolve: vi.fn() } satisfies SkillImportResolver;
    const service = new SkillImportApplicationService(repository(), resolver, unexpectedAuthor);

    await expect(
      service.preview({ ...actor, permissions: [] }, { url: "github.com/o/r" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("keeps bundle contents out of the public preview", async () => {
    const service = new SkillImportApplicationService(
      repository(),
      { resolve: vi.fn(async () => resolved) },
      unexpectedAuthor,
    );

    const preview = await service.preview(actor, { url: "github.com/o/r" });

    expect(preview).toMatchObject({
      status: "resolved",
      name: "my-skill",
      files: [{ path: "SKILL.md", sizeBytes: files[0]!.content.length }],
      warnings: [
        {
          code: "source_directory_normalized",
          message: "Source directory normalized.",
        },
      ],
    });
    expect(preview).not.toHaveProperty("body");
    expect(preview).not.toHaveProperty("files.0.content");
    expect(preview).not.toHaveProperty("files.0.executable");
  });

  it("binds persistence to the exact previewed commit and integrity", async () => {
    const install = vi.fn(async () => ({ installation: {} as never, idempotentReplay: false }));
    const service = new SkillImportApplicationService(
      repository({ install }),
      { resolve: vi.fn(async () => resolved) },
      unexpectedAuthor,
    );

    await service.install(actor, {
      idempotencyKey: "skill-install-1",
      url: "github.com/o/r",
      expectedResolvedCommit: resolvedCommit,
      expectedIntegrity: integrity,
    });

    expect(install).toHaveBeenCalledWith({
      actor,
      idempotencyKey: "skill-install-1",
      bundle: resolved.bundle,
    });
  });

  it("rejects changed content before persistence", async () => {
    const install = vi.fn();
    const service = new SkillImportApplicationService(
      repository({ install }),
      { resolve: vi.fn(async () => resolved) },
      unexpectedAuthor,
    );

    await expect(
      service.install(actor, {
        idempotencyKey: "skill-install-1",
        url: "github.com/o/r",
        expectedResolvedCommit: "c".repeat(40),
        expectedIntegrity: integrity,
      }),
    ).rejects.toEqual(
      new CoreError(
        "conflict",
        "This skill changed since the preview. Preview it again before installing.",
      ),
    );
    expect(install).not.toHaveBeenCalled();
  });
});

describe("createSkillFileChunk", () => {
  it("returns UTF-8 chunks on character boundaries", () => {
    const content = new TextEncoder().encode("a€b");
    const first = createSkillFileChunk(
      { path: "notes.txt", content, executable: false, sizeBytes: content.length },
      { maxBytes: 4 },
    );
    const second = createSkillFileChunk(
      { path: "notes.txt", content, executable: false, sizeBytes: content.length },
      { offset: first.nextOffset, maxBytes: 4 },
    );

    expect(first).toMatchObject({ encoding: "utf8", content: "a€", nextOffset: 4, eof: false });
    expect(second).toMatchObject({ encoding: "utf8", content: "b", eof: true });
  });

  it("returns binary chunks as base64", () => {
    const content = Uint8Array.of(0, 255, 1, 2, 3);
    const chunk = createSkillFileChunk(
      { path: "data.bin", content, executable: true, sizeBytes: content.length },
      { maxBytes: 4 },
    );

    expect(chunk).toMatchObject({
      encoding: "base64",
      content: Buffer.from(content.subarray(0, 4)).toString("base64"),
      nextOffset: 4,
      eof: false,
    });
  });
});

function repository(overrides: Partial<SkillBundleRepository> = {}): SkillBundleRepository {
  return {
    install: vi.fn(async () => ({ installation: {} as never, idempotentReplay: false })),
    replace: vi.fn(async () => ({}) as never),
    list: vi.fn(async () => []),
    listCatalog: vi.fn(async () => []),
    get: vi.fn(async () => null),
    readFile: vi.fn(async () => null),
    setEnabled: vi.fn(async () => ({}) as never),
    archive: vi.fn(async () => undefined),
    ...overrides,
  };
}
