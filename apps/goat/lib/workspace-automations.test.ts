import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  listGoatSkillCatalog,
  resolveGoatSkillMentions,
  validateGoatSkillFields,
} from "@/lib/skills";
import {
  GoatWorkflowMentionError,
  listGoatWorkflowCatalog,
  resolveGoatWorkflowMention,
} from "@/lib/workflows";

const pgDialect = new PgDialect();

describe("workspace automation lifecycle", () => {
  it("only lists active workflows in the composer catalog", async () => {
    const builder = createSelectBuilder([
      {
        slug: "launch-brief",
        name: "Launch brief",
        description: "Prepare the brief",
        instructions: "Draft the launch brief.",
        model: "",
        steps: [],
      },
    ]);
    const db = { select: vi.fn(() => builder) };

    await expect(listGoatWorkflowCatalog("workspace_1", db as never)).resolves.toEqual([
      { id: "launch-brief", name: "Launch brief", description: "Prepare the brief" },
    ]);
    expect(renderQuery(builder.whereValue).params).toContain("active");
  });

  it("refuses to fire a draft workflow even when its slug resolves", async () => {
    const builder = createSelectBuilder([
      {
        slug: "launch-brief",
        name: "Launch brief",
        description: "Prepare the brief",
        instructions: "Draft the launch brief.",
        model: "",
        steps: [],
        status: "draft",
      },
    ]);
    const db = { select: vi.fn(() => builder) };

    await expect(
      resolveGoatWorkflowMention({
        workspaceId: "workspace_1",
        mention: { id: "launch-brief" },
        db: db as never,
      }),
    ).rejects.toBeInstanceOf(GoatWorkflowMentionError);
  });

  it("refuses to fire an active workflow before it has runnable instructions", async () => {
    const builder = createSelectBuilder([
      {
        slug: "launch-brief",
        name: "Launch brief",
        description: "Prepare the brief",
        instructions: "",
        model: "",
        steps: [{ id: "step-1", title: "", model: "", instructions: "" }],
        status: "active",
      },
    ]);
    const db = { select: vi.fn(() => builder) };

    await expect(
      resolveGoatWorkflowMention({
        workspaceId: "workspace_1",
        mention: { id: "launch-brief" },
        db: db as never,
      }),
    ).rejects.toBeInstanceOf(GoatWorkflowMentionError);
  });

  it("only lists and resolves active skills", async () => {
    const catalogBuilder = createSelectBuilder([
      { slug: "legal-review", name: "Legal review", description: "Check legal language" },
    ]);
    const resolveBuilder = createSelectBuilder([
      {
        slug: "legal-review",
        name: "Legal review",
        description: "Check legal language",
        instructions: "Flag claims that need counsel.",
      },
    ]);
    const db = {
      select: vi.fn().mockReturnValueOnce(catalogBuilder).mockReturnValueOnce(resolveBuilder),
    };

    await expect(listGoatSkillCatalog("workspace_1", db as never)).resolves.toEqual([
      { id: "legal-review", name: "Legal review", description: "Check legal language" },
    ]);
    await expect(
      resolveGoatSkillMentions({
        workspaceId: "workspace_1",
        mentions: [{ id: "legal-review" }],
        db: db as never,
      }),
    ).resolves.toEqual([
      {
        id: "legal-review",
        name: "Legal review",
        description: "Check legal language",
        instructions: "Flag claims that need counsel.",
      },
    ]);

    expect(renderQuery(catalogBuilder.whereValue).params).toContain("active");
    expect(renderQuery(resolveBuilder.whereValue).params).toContain("active");
  });

  it("requires instructions before a skill can become active", () => {
    expect(
      validateGoatSkillFields({
        name: "Legal review",
        description: "",
        instructions: "",
        status: "active",
      }),
    ).toMatch(/instructions/);
  });
});

function createSelectBuilder(rows: unknown[]) {
  const builder = {
    whereValue: undefined as SQL | undefined,
    from: vi.fn(() => builder),
    where: vi.fn((value: SQL) => {
      builder.whereValue = value;
      return builder;
    }),
    orderBy: vi.fn(async () => rows),
    limit: vi.fn(async () => rows),
    then: <TResult1 = unknown[], TResult2 = never>(
      onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(rows).then(onfulfilled, onrejected),
  };
  return builder;
}

function renderQuery(query: SQL | undefined) {
  if (!query) throw new Error("Expected a SQL query.");
  return pgDialect.sqlToQuery(query);
}
