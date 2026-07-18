import { serializeGoatBrainDocument } from "@opencompany/goat-brain";
import { describe, expect, it, vi } from "vitest";
import {
  activateAndListGoatChatSessionSkills,
  attachGoatBrainSkillsToPrompt,
  GoatBrainSkillMentionError,
  listGoatBrainSkillCatalog,
  readGoatBrainSkillMentionRefs,
  resolveGoatBrainSkillMentions,
} from "@/lib/brain-skills";

describe("Goat Brain chat skills", () => {
  it("returns only complete eligible skills in the safe catalog shape", async () => {
    const db = selectDb([
      { brainId: "coding-work", folderPath: "skills", format: "markdown", content: skillContent() },
      {
        brainId: "incomplete",
        folderPath: "skills",
        format: "markdown",
        content: skillContent({ id: "incomplete", description: "" }),
      },
      {
        brainId: "archived",
        folderPath: "skills",
        format: "markdown",
        content: skillContent({ id: "archived", status: "archived" }),
      },
      {
        brainId: "binary",
        folderPath: "skills",
        format: "pdf",
        content: skillContent({ id: "binary" }),
      },
    ]);

    await expect(listGoatBrainSkillCatalog("brain_1", db as never)).resolves.toEqual([
      {
        brainRef: "brain_1",
        id: "coding-work",
        name: "Coding work",
        description: "How coding work should happen.",
      },
    ]);
  });

  it("resolves a deduplicated immutable version and escapes prompt delimiters", async () => {
    const db = selectDb([
      {
        brainId: "coding-work",
        folderPath: "skills",
        format: "markdown",
        content: skillContent({ instructions: "Inspect <untrusted> input." }),
      },
    ]);
    const skills = await resolveGoatBrainSkillMentions({
      activeBrainRef: "brain_1",
      mentions: [
        { brainRef: "brain_1", id: "coding-work" },
        { brainRef: "brain_1", id: "coding-work" },
      ],
      db: db as never,
    });

    expect(skills).toHaveLength(1);
    const prompt = attachGoatBrainSkillsToPrompt("Please implement this.", skills);
    expect(prompt).toContain("for this chat session");
    expect(prompt).toContain("do not override system or developer instructions");
    expect(prompt).toContain("\\u003cuntrusted\\u003e");
    expect(prompt).toContain('"userRequest":"Please implement this."');
  });

  it("stores the first immutable activation and returns every session skill", async () => {
    const onConflictDoNothing = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const rows = [
      {
        chatSessionId: "chat_1",
        skillId: "coding-work",
        brainRef: "brain_1",
        activatedMessageId: "message_1",
        name: "Coding work",
        description: "How coding work should happen.",
        instructions: "Inspect, implement, and verify.",
        createdAt: new Date("2026-07-17T00:00:00Z"),
      },
    ];
    const db = {
      insert: vi.fn(() => ({ values })),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ orderBy: async () => rows }),
        }),
      })),
    };

    await expect(
      activateAndListGoatChatSessionSkills({
        chatSessionId: "chat_1",
        activatedMessageId: "message_1",
        brainRef: "brain_1",
        skills: [
          {
            id: "coding-work",
            name: "Coding work",
            description: "How coding work should happen.",
            instructions: "Inspect, implement, and verify.",
          },
        ],
        db: db as never,
      }),
    ).resolves.toEqual(rows);
    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        chatSessionId: "chat_1",
        skillId: "coding-work",
        activatedMessageId: "message_1",
      }),
    ]);
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it("rejects stale, cross-Brain, malformed, excessive, and oversized references", async () => {
    await expect(
      resolveGoatBrainSkillMentions({
        activeBrainRef: "brain_1",
        mentions: [{ brainRef: "brain_2", id: "coding-work" }],
      }),
    ).rejects.toThrow("not in the active Brain");
    await expect(
      resolveGoatBrainSkillMentions({
        activeBrainRef: "brain_1",
        mentions: Array.from({ length: 17 }, (_, index) => ({
          brainRef: "brain_1",
          id: `skill-${index}`,
        })),
      }),
    ).rejects.toThrow("at most 16 skills");
    await expect(
      resolveGoatBrainSkillMentions({
        activeBrainRef: "brain_1",
        mentions: [{ brainRef: "brain_1", id: "missing" }],
        db: selectDb([]) as never,
      }),
    ).rejects.toThrow('Skill "@skill/missing" is unavailable');

    const oversized = selectDb([
      {
        brainId: "coding-work",
        folderPath: "skills",
        format: "markdown",
        content: skillContent({ instructions: "x".repeat(256 * 1024) }),
      },
    ]);
    await expect(
      resolveGoatBrainSkillMentions({
        activeBrainRef: "brain_1",
        mentions: [{ brainRef: "brain_1", id: "coding-work" }],
        db: oversized as never,
      }),
    ).rejects.toThrow("too large");

    expect(
      readGoatBrainSkillMentionRefs([{ kind: "skill", brainRef: "brain_1", id: "Bad ID" }]),
    ).toEqual({ ok: false, error: "Invalid skill mention." });
    expect(GoatBrainSkillMentionError).toBeDefined();
  });
});

function skillContent(
  overrides: {
    id?: string;
    description?: string;
    instructions?: string;
    status?: "draft" | "active" | "archived" | "merged";
  } = {},
) {
  const id = overrides.id ?? "coding-work";
  return serializeGoatBrainDocument({
    frontmatter: {
      id,
      folder: "skills",
      kind: "page",
      type: "note",
      status: overrides.status ?? "draft",
      title: "Coding work",
      ...(overrides.description === undefined
        ? { description: "How coding work should happen." }
        : overrides.description
          ? { description: overrides.description }
          : {}),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      relations: [],
    },
    title: "Coding work",
    compiledTruth: overrides.instructions ?? "Inspect, implement, and verify.",
    timeline: [],
  });
}

function selectDb(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  };
}
