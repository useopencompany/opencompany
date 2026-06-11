import { describe, expect, test } from "vitest";
import { parseAgentFile, serializeAgentFile } from "./agent-file";
import { resolveAgentRuntimeConfig } from "./config";
import {
  AGENT_SELF_EDIT_SKILL_ID,
  computeSkillFolderIntegrity,
  FIRST_PRINCIPLES_SKILL_ID,
  HUMANIZER_SKILL_ID,
  isKnownAgentSkillId,
  listAddableBuiltinSkills,
  MAX_PERSONAL_SKILLS,
  MEMORY_SKILL_ID,
  normalizeAgentSkills,
  normalizeExternalSkillReference,
  ONBOARDING_SKILL_ID,
  OPENCOMPANY_SETUP_SKILL_ID,
  resolveEnabledBuiltinSkillFiles,
  resolveEnabledSkillMetadata,
  SKILL_CREATOR_SKILL_ID,
  scanPersonalSkills,
} from "./skills";
import type { AgentConfig, AgentExternalSkillReference } from "./types";

function externalSkill(
  overrides: Partial<AgentExternalSkillReference> = {},
): AgentExternalSkillReference {
  return {
    id: "improve-codebase-architecture",
    name: "Improve Codebase Architecture",
    description: "Analyze codebases for architectural friction.",
    source: {
      type: "github",
      url: "https://github.com/mattpocock/skills",
      ref: "main",
      path: "skills/improve-codebase-architecture",
    },
    ...overrides,
  };
}

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaVersion: "agent.v1",
    title: "Test agent",
    instructions: "Do the thing.",
    model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
    tools: [],
    brain: [],
    agents: [],
    integrations: { github: { repositories: [] } },
    triggers: [],
    ...overrides,
  };
}

describe("skill catalog", () => {
  test("the self-edit skill is known and ships a SKILL.md", () => {
    expect(isKnownAgentSkillId(AGENT_SELF_EDIT_SKILL_ID)).toBe(true);
    const [skill] = resolveEnabledBuiltinSkillFiles(baseConfig());
    expect(skill?.id).toBe(AGENT_SELF_EDIT_SKILL_ID);
    expect(skill?.files.some((file) => file.path === "SKILL.md")).toBe(true);
  });

  test("resolveEnabledBuiltinSkillFiles always includes defaultEnabled skills", () => {
    expect(resolveEnabledBuiltinSkillFiles(baseConfig()).map((skill) => skill.id)).toContain(
      AGENT_SELF_EDIT_SKILL_ID,
    );
  });

  test("the opencompany-setup skill is default-enabled and ships a SKILL.md", () => {
    expect(isKnownAgentSkillId(OPENCOMPANY_SETUP_SKILL_ID)).toBe(true);
    const setup = resolveEnabledBuiltinSkillFiles(baseConfig()).find(
      (skill) => skill.id === OPENCOMPANY_SETUP_SKILL_ID,
    );
    expect(setup?.files.some((file) => file.path === "SKILL.md")).toBe(true);
  });

  test("the opencompany-setup SKILL.md teaches Brain setup and hands off to self-edit", () => {
    const setup = resolveEnabledBuiltinSkillFiles(baseConfig()).find(
      (skill) => skill.id === OPENCOMPANY_SETUP_SKILL_ID,
    );
    const skillMd = setup?.files.find((file) => file.path === "SKILL.md")?.content ?? "";
    // Brain is the surface it sets up.
    expect(skillMd).toMatch(/brain\//i);
    expect(skillMd).toMatch(/@brain\//);
    // It points back at the self-edit skill for tuning the agent's own definition.
    expect(skillMd).toContain(AGENT_SELF_EDIT_SKILL_ID);
    // It uses the structured question pause instead of a plain chat question for setup.
    expect(skillMd).toContain("ask_user_question");
    expect(skillMd).toContain("Do not ask these as plain chat questions");
  });

  test("the self-edit SKILL.md enumerates addable tool mentions with prerequisites", () => {
    const [skill] = resolveEnabledBuiltinSkillFiles(baseConfig());
    const skillMd = skill?.files.find((file) => file.path === "SKILL.md")?.content ?? "";
    // Tools the agent can @mention to add to itself.
    expect(skillMd).toContain("`@exa`");
    expect(skillMd).toContain("`@amp`");
    // The amp prerequisite (attached repo) is surfaced so the agent doesn't add an inert tool.
    expect(skillMd).toMatch(/GitHub repository attached/i);
  });

  test("the self-edit SKILL.md documents the read-before-edit gate", () => {
    const [skill] = resolveEnabledBuiltinSkillFiles(baseConfig());
    const skillMd = skill?.files.find((file) => file.path === "SKILL.md")?.content ?? "";

    expect(skillMd).toMatch(/requires that you have read this skill/i);
    expect(skillMd).toContain("read_skill");
  });

  test("the skill-creator skill is default-enabled and teaches the agent/skills convention", () => {
    expect(isKnownAgentSkillId(SKILL_CREATOR_SKILL_ID)).toBe(true);
    const creator = resolveEnabledBuiltinSkillFiles(baseConfig()).find(
      (skill) => skill.id === SKILL_CREATOR_SKILL_ID,
    );
    const skillMd = creator?.files.find((file) => file.path === "SKILL.md")?.content ?? "";
    expect(skillMd).toContain("agent/skills/<id>/SKILL.md");
    // It must teach the required frontmatter and that activation is next-turn (same session).
    expect(skillMd).toMatch(/name/);
    expect(skillMd).toMatch(/description/);
    expect(skillMd).toMatch(/next turn in this same session/i);
  });

  test("normalizeAgentSkills keeps known ids and drops unknown ones", () => {
    expect(
      normalizeAgentSkills([AGENT_SELF_EDIT_SKILL_ID, "made-up-skill", { id: "also-fake" }]),
    ).toEqual([{ id: AGENT_SELF_EDIT_SKILL_ID }]);
  });

  test("normalizeAgentSkills dedupes", () => {
    expect(
      normalizeAgentSkills([AGENT_SELF_EDIT_SKILL_ID, { id: AGENT_SELF_EDIT_SKILL_ID }]),
    ).toEqual([{ id: AGENT_SELF_EDIT_SKILL_ID }]);
  });
});

describe("first-principles skill (addable built-in)", () => {
  test("is a known built-in but off by default", () => {
    expect(isKnownAgentSkillId(FIRST_PRINCIPLES_SKILL_ID)).toBe(true);
    // Not in the default-on set: a base config (no skills listed) must not materialize it.
    expect(resolveEnabledBuiltinSkillFiles(baseConfig()).map((s) => s.id)).not.toContain(
      FIRST_PRINCIPLES_SKILL_ID,
    );
    expect(resolveEnabledSkillMetadata(baseConfig()).map((s) => s.id)).not.toContain(
      FIRST_PRINCIPLES_SKILL_ID,
    );
  });

  test("materializes once listed in config.skills as a bare built-in ref", () => {
    const config = baseConfig({ skills: [{ id: FIRST_PRINCIPLES_SKILL_ID }] });
    const skill = resolveEnabledBuiltinSkillFiles(config).find(
      (s) => s.id === FIRST_PRINCIPLES_SKILL_ID,
    );
    const skillMd = skill?.files.find((file) => file.path === "SKILL.md")?.content ?? "";
    // Ships the framework: 15 numbered prompts plus the read-on-demand framing.
    expect(skillMd).toContain("first-principles");
    expect(skillMd).toMatch(/15-prompt|15 prompts|fundamental/i);
    expect(skillMd).toContain("15.");
    expect(
      resolveEnabledSkillMetadata(config).find((s) => s.id === FIRST_PRINCIPLES_SKILL_ID)?.origin,
    ).toBe("builtin");
  });

  test("listAddableBuiltinSkills offers it and excludes internal/default-on skills", () => {
    const addable = listAddableBuiltinSkills();
    const ids = addable.map((s) => s.id);
    expect(ids).toContain(FIRST_PRINCIPLES_SKILL_ID);
    // Internal first-session skill must never be offered in the picker.
    expect(ids).not.toContain(ONBOARDING_SKILL_ID);
    // Always-on built-ins aren't "addable" — they're already present.
    expect(ids).not.toContain(AGENT_SELF_EDIT_SKILL_ID);
    expect(addable.every((s) => s.origin === "builtin" && s.name && s.description)).toBe(true);
  });

  test("the self-edit skill documents adding a built-in skill via @skill mention", () => {
    const [skill] = resolveEnabledBuiltinSkillFiles(baseConfig());
    const skillMd = skill?.files.find((file) => file.path === "SKILL.md")?.content ?? "";
    expect(skillMd).toContain("@skill/");
    expect(skillMd).toContain(`@skill/${FIRST_PRINCIPLES_SKILL_ID}`);
    expect(skillMd).toContain(`@skill/${HUMANIZER_SKILL_ID}`);
  });
});

describe("humanizer skill (addable built-in)", () => {
  test("is a known built-in but off by default", () => {
    expect(isKnownAgentSkillId(HUMANIZER_SKILL_ID)).toBe(true);
    expect(resolveEnabledBuiltinSkillFiles(baseConfig()).map((s) => s.id)).not.toContain(
      HUMANIZER_SKILL_ID,
    );
    expect(resolveEnabledSkillMetadata(baseConfig()).map((s) => s.id)).not.toContain(
      HUMANIZER_SKILL_ID,
    );
  });

  test("materializes once listed in config.skills as a bare built-in ref", () => {
    const config = baseConfig({ skills: [{ id: HUMANIZER_SKILL_ID }] });
    const skill = resolveEnabledBuiltinSkillFiles(config).find((s) => s.id === HUMANIZER_SKILL_ID);
    const skillMd = skill?.files.find((file) => file.path === "SKILL.md")?.content ?? "";
    // Ships the pattern catalog and the voice guidance.
    expect(skillMd).toContain("humanizer");
    expect(skillMd).toMatch(/AI-generated/i);
    expect(skillMd).toMatch(/voice/i);
    expect(
      resolveEnabledSkillMetadata(config).find((s) => s.id === HUMANIZER_SKILL_ID)?.origin,
    ).toBe("builtin");
  });

  test("listAddableBuiltinSkills offers it", () => {
    expect(listAddableBuiltinSkills().map((s) => s.id)).toContain(HUMANIZER_SKILL_ID);
  });
});

describe("skills frontmatter round-trip", () => {
  test("known skills serialize and parse back", () => {
    const source = serializeAgentFile({
      title: "Agent",
      body: "Help out.",
      skills: [{ id: AGENT_SELF_EDIT_SKILL_ID }],
    });
    expect(source).toContain("skills:");
    const parsed = parseAgentFile(source);
    expect(parsed.config.skills).toEqual([{ id: AGENT_SELF_EDIT_SKILL_ID }]);
  });

  test("omits the skills key entirely when none are set", () => {
    const source = serializeAgentFile({ title: "Agent", body: "Help out." });
    expect(source).not.toContain("skills:");
    expect(parseAgentFile(source).config.skills).toBeUndefined();
  });
});

describe("external skills", () => {
  test("normalizeExternalSkillReference accepts a well-formed object", () => {
    expect(normalizeExternalSkillReference(externalSkill())).toEqual(externalSkill());
  });

  test("normalizeExternalSkillReference rejects malformed objects", () => {
    expect(normalizeExternalSkillReference(externalSkill({ id: "Bad Id" }))).toBeNull();
    expect(normalizeExternalSkillReference(externalSkill({ id: "has--double" }))).toBeNull();
    expect(normalizeExternalSkillReference(externalSkill({ name: "" }))).toBeNull();
    expect(
      normalizeExternalSkillReference({ ...externalSkill(), source: { type: "ftp", url: "x" } }),
    ).toBeNull();
    expect(
      normalizeExternalSkillReference({
        ...externalSkill(),
        source: { ...externalSkill().source, url: "http://insecure" },
      }),
    ).toBeNull();
    expect(
      normalizeExternalSkillReference({
        ...externalSkill(),
        source: { ...externalSkill().source, path: "../escape" },
      }),
    ).toBeNull();
  });

  test("normalizeExternalSkillReference rejects external skills colliding with a built-in id", () => {
    expect(
      normalizeExternalSkillReference(externalSkill({ id: AGENT_SELF_EDIT_SKILL_ID })),
    ).toBeNull();
  });

  test("normalizeAgentSkills keeps external objects alongside built-in ids", () => {
    const skill = externalSkill();
    expect(normalizeAgentSkills([AGENT_SELF_EDIT_SKILL_ID, skill, "made-up"])).toEqual([
      { id: AGENT_SELF_EDIT_SKILL_ID },
      skill,
    ]);
  });

  test("normalizeAgentSkills dedupes external skills by id", () => {
    const skill = externalSkill();
    expect(normalizeAgentSkills([skill, externalSkill({ name: "Other" })])).toEqual([skill]);
  });

  test("external skills round-trip through serialize/parse as objects", () => {
    const skill = externalSkill();
    const source = serializeAgentFile({ title: "Agent", body: "Help out.", skills: [skill] });
    expect(source).toContain("skills:");
    const parsed = parseAgentFile(source);
    expect(parsed.config.skills).toEqual([skill]);
    // Idempotent: re-serializing the parsed result is byte-stable.
    expect(
      serializeAgentFile({
        title: parsed.title,
        body: parsed.body,
        model: parsed.config.model.name,
        skills: parsed.config.skills ?? [],
      }),
    ).toEqual(source);
  });

  test("resolveEnabledSkillMetadata lists built-ins plus external skills", () => {
    const skill = externalSkill();
    const metadata = resolveEnabledSkillMetadata(baseConfig({ skills: [skill] }));
    expect(metadata.find((m) => m.id === AGENT_SELF_EDIT_SKILL_ID)?.origin).toBe("builtin");
    const external = metadata.find((m) => m.id === skill.id);
    expect(external?.origin).toBe("external");
    expect(external?.source?.url).toBe(skill.source.url);
  });

  test("resolveEnabledBuiltinSkillFiles excludes external skills (no files in code)", () => {
    const ids = resolveEnabledBuiltinSkillFiles(baseConfig({ skills: [externalSkill()] })).map(
      (s) => s.id,
    );
    expect(ids).not.toContain("improve-codebase-architecture");
    expect(ids).toContain(AGENT_SELF_EDIT_SKILL_ID);
  });

  test("computeSkillFolderIntegrity is order-independent and content-sensitive", async () => {
    const a = await computeSkillFolderIntegrity([
      { path: "SKILL.md", content: "one" },
      { path: "LANGUAGE.md", content: "two" },
    ]);
    const reordered = await computeSkillFolderIntegrity([
      { path: "LANGUAGE.md", content: "two" },
      { path: "SKILL.md", content: "one" },
    ]);
    const changed = await computeSkillFolderIntegrity([
      { path: "SKILL.md", content: "one!" },
      { path: "LANGUAGE.md", content: "two" },
    ]);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reordered).toBe(a);
    expect(changed).not.toBe(a);
  });
});

describe("resolveAgentRuntimeConfig skills section", () => {
  test("advertises enabled skills and exposes update_agent_file", () => {
    const resolved = resolveAgentRuntimeConfig({ agent: baseConfig() });
    expect(resolved.systemPrompt).toContain("## Skills");
    expect(resolved.systemPrompt).toContain(`skills/${AGENT_SELF_EDIT_SKILL_ID}/SKILL.md`);
    expect(resolved.systemPrompt).toContain("read its SKILL.md first with read_skill");
    expect(resolved.tools).toContain("update_agent_file");
    expect(resolved.tools).toContain("read_skill");
  });

  test("always advertises the personal-skills authoring surface and points at skill-creator", () => {
    const resolved = resolveAgentRuntimeConfig({ agent: baseConfig() });
    expect(resolved.systemPrompt).toContain("agent/skills/<id>/SKILL.md");
    expect(resolved.systemPrompt).toContain(`skillId "${SKILL_CREATOR_SKILL_ID}"`);
    // skill-creator is a built-in, so it is also advertised in the ## Skills index.
    expect(resolved.systemPrompt).toContain(`skills/${SKILL_CREATOR_SKILL_ID}/SKILL.md`);
  });

  test("lists discovered personal skills by mount path without inlining untrusted name/description", () => {
    const resolved = resolveAgentRuntimeConfig({
      agent: baseConfig(),
      personalSkills: [
        {
          id: "weekly-digest",
          name: "Weekly digest",
          description: "Post the Monday digest.",
          origin: "personal",
        },
      ],
    });
    expect(resolved.systemPrompt).toContain("skills/weekly-digest/SKILL.md");
    // Personal skills carry agent-/user-authored frontmatter, so only the mount path is advertised —
    // the name/description must NOT be rendered inline (prompt-injection surface).
    expect(resolved.systemPrompt).toContain("Personal skill (skills/weekly-digest/SKILL.md)");
    expect(resolved.systemPrompt).not.toContain("Weekly digest — Post the Monday digest.");
  });

  test("personal skills never shadow a built-in id", () => {
    const resolved = resolveAgentRuntimeConfig({
      agent: baseConfig(),
      personalSkills: [
        {
          id: MEMORY_SKILL_ID,
          name: "Fake memory",
          description: "malicious override",
          origin: "personal",
        },
      ],
    });
    expect(resolved.systemPrompt).not.toContain("malicious override");
    const occurrences =
      resolved.systemPrompt.split(`skills/${MEMORY_SKILL_ID}/SKILL.md`).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("scanPersonalSkills", () => {
  const bundleDir = "agents/leo";

  function file(path: string, content: string) {
    return { path: `${bundleDir}/${path}`, content };
  }

  function skillMd(name: string, description: string, extra = "") {
    return `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody.`;
  }

  test("discovers a well-formed skill folder with supporting files and provenance", () => {
    const { skills, warnings } = scanPersonalSkills({
      bundleDir,
      bundleFiles: [
        file(
          "skills/weekly-digest/SKILL.md",
          skillMd("Weekly digest", "Monday digest.", "provenance: agent\n"),
        ),
        file("skills/weekly-digest/references/format.md", "format"),
        file("memory.md", "not a skill"),
        file("skills/loose-file.md", "ignored — not in a skill folder"),
      ],
    });
    expect(warnings).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.metadata).toMatchObject({
      id: "weekly-digest",
      name: "Weekly digest",
      description: "Monday digest.",
      origin: "personal",
      provenance: "agent",
    });
    expect(skills[0]?.files.map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "references/format.md",
    ]);
  });

  test("reads a personal skill's optional command slug", () => {
    const { skills, warnings } = scanPersonalSkills({
      bundleDir,
      bundleFiles: [
        file(
          "skills/weekly-digest/SKILL.md",
          skillMd("Weekly digest", "Monday digest.", "command: /Weekly-Digest\n"),
        ),
      ],
    });
    expect(warnings).toEqual([]);
    expect(skills[0]?.metadata.command).toBe("weekly_digest");
  });

  test("skips a folder with missing/invalid frontmatter, with a warning", () => {
    const { skills, warnings } = scanPersonalSkills({
      bundleDir,
      bundleFiles: [file("skills/no-front/SKILL.md", "no frontmatter here")],
    });
    expect(skills).toHaveLength(0);
    expect(warnings.join(" ")).toContain("no-front");
  });

  test("skips a folder without a SKILL.md", () => {
    const { skills, warnings } = scanPersonalSkills({
      bundleDir,
      bundleFiles: [file("skills/orphan/notes.md", "just notes")],
    });
    expect(skills).toHaveLength(0);
    expect(warnings.join(" ")).toContain("orphan");
  });

  test("skips an invalid skill id", () => {
    const { skills, warnings } = scanPersonalSkills({
      bundleDir,
      bundleFiles: [file("skills/Bad_Id/SKILL.md", skillMd("Bad", "Bad id."))],
    });
    expect(skills).toHaveLength(0);
    expect(warnings.join(" ")).toContain("Bad_Id");
  });

  test("drops collisions with built-in and reserved external ids", () => {
    const { skills, warnings } = scanPersonalSkills({
      bundleDir,
      reservedIds: ["my-external"],
      bundleFiles: [
        file(`skills/${MEMORY_SKILL_ID}/SKILL.md`, skillMd("Fake", "override.")),
        file("skills/my-external/SKILL.md", skillMd("Shadow", "override external.")),
        file("skills/keeper/SKILL.md", skillMd("Keeper", "a real one.")),
      ],
    });
    expect(skills.map((s) => s.metadata.id)).toEqual(["keeper"]);
    expect(warnings.join(" ")).toContain(MEMORY_SKILL_ID);
    expect(warnings.join(" ")).toContain("my-external");
  });

  test("caps the number of surfaced skills", () => {
    const bundleFiles = [];
    for (let i = 0; i < MAX_PERSONAL_SKILLS + 3; i++) {
      bundleFiles.push(file(`skills/skill-${i}/SKILL.md`, skillMd(`Skill ${i}`, `desc ${i}`)));
    }
    const { skills, warnings } = scanPersonalSkills({ bundleDir, bundleFiles });
    expect(skills).toHaveLength(MAX_PERSONAL_SKILLS);
    expect(warnings.some((w) => w.includes("cap"))).toBe(true);
  });
});
