import { describe, expect, test } from "vitest";
import { parseAgentFile, serializeAgentFile } from "./agent-file";
import { resolveAgentRuntimeConfig } from "./config";
import {
  AGENT_SELF_EDIT_SKILL_ID,
  isKnownAgentSkillId,
  normalizeAgentSkills,
  resolveEnabledSkills,
} from "./skills";
import type { AgentConfig } from "./types";

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
    const [skill] = resolveEnabledSkills(baseConfig());
    expect(skill?.id).toBe(AGENT_SELF_EDIT_SKILL_ID);
    expect(skill?.files.some((file) => file.path === "SKILL.md")).toBe(true);
  });

  test("resolveEnabledSkills always includes defaultEnabled skills", () => {
    expect(resolveEnabledSkills(baseConfig()).map((skill) => skill.id)).toContain(
      AGENT_SELF_EDIT_SKILL_ID,
    );
  });

  test("the self-edit SKILL.md enumerates addable tool mentions with prerequisites", () => {
    const [skill] = resolveEnabledSkills(baseConfig());
    const skillMd = skill?.files.find((file) => file.path === "SKILL.md")?.content ?? "";
    // Tools the agent can @mention to add to itself.
    expect(skillMd).toContain("`@exa`");
    expect(skillMd).toContain("`@amp`");
    // The amp prerequisite (attached repo) is surfaced so the agent doesn't add an inert tool.
    expect(skillMd).toMatch(/GitHub repository attached/i);
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

describe("resolveAgentRuntimeConfig skills section", () => {
  test("advertises enabled skills and exposes update_agent_file", () => {
    const resolved = resolveAgentRuntimeConfig({ agent: baseConfig() });
    expect(resolved.systemPrompt).toContain("Skills available this session");
    expect(resolved.systemPrompt).toContain(`skills/${AGENT_SELF_EDIT_SKILL_ID}/SKILL.md`);
    expect(resolved.systemPrompt).toContain("read them with read_skill");
    expect(resolved.tools).toContain("update_agent_file");
    expect(resolved.tools).toContain("read_skill");
  });
});
