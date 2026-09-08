import type { JSONSchema7 } from "ai";
import {
  CREATE_WORKSPACE_SKILL_DESCRIPTION_DESCRIPTION,
  CREATE_WORKSPACE_SKILL_INSTRUCTIONS_DESCRIPTION,
  CREATE_WORKSPACE_SKILL_NAME_DESCRIPTION,
  CREATE_WORKSPACE_SKILL_TOOL_DESCRIPTION,
  EDIT_WORKSPACE_SKILL_DESCRIPTION_DESCRIPTION,
  EDIT_WORKSPACE_SKILL_INSTRUCTIONS_DESCRIPTION,
  EDIT_WORKSPACE_SKILL_NAME_DESCRIPTION,
  EDIT_WORKSPACE_SKILL_TOOL_DESCRIPTION,
} from "./prompts/tool-descriptions";

export type WorkspaceSkillsInput = {
  command: "list" | "read" | "archive";
  name?: string;
};

export const WORKSPACE_SKILLS_TOOL_NAME = "workspace_skills";
export const WORKSPACE_SKILLS_TOOL_DESCRIPTION =
  "Manage installed standalone Skills in the active workspace. list includes enabled and disabled installations with their source and whether they can be edited. read requires an exact name and returns the latest saved description and Markdown instructions without activating the Skill; use this before editing, even if a chat already has an older version loaded. archive requires an exact name and removes that installation from future selection while preserving existing chat and task snapshots. Archive only when the user has asked to remove, delete, or archive that Skill. Plugin Skills are managed through their Plugin. Use create_workspace_skill to add a Skill and edit_workspace_skill to save revised instructions.";
export const WORKSPACE_SKILLS_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: { type: "string", enum: ["list", "read", "archive"] },
    name: {
      type: "string",
      description: "Exact installation name, required for read and archive.",
    },
  },
  required: ["command"],
} satisfies JSONSchema7;

export const WORKSPACE_SKILL_AUTHORING_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      description: CREATE_WORKSPACE_SKILL_NAME_DESCRIPTION,
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: 1_024,
      description: CREATE_WORKSPACE_SKILL_DESCRIPTION_DESCRIPTION,
    },
    instructions: {
      type: "string",
      minLength: 1,
      maxLength: 512 * 1_024,
      description: CREATE_WORKSPACE_SKILL_INSTRUCTIONS_DESCRIPTION,
    },
  },
  required: ["name", "description", "instructions"],
} satisfies JSONSchema7;

export const WORKSPACE_SKILL_EDIT_INPUT_SCHEMA = {
  ...WORKSPACE_SKILL_AUTHORING_INPUT_SCHEMA,
  properties: {
    ...WORKSPACE_SKILL_AUTHORING_INPUT_SCHEMA.properties,
    name: {
      ...WORKSPACE_SKILL_AUTHORING_INPUT_SCHEMA.properties.name,
      description: EDIT_WORKSPACE_SKILL_NAME_DESCRIPTION,
    },
    description: {
      ...WORKSPACE_SKILL_AUTHORING_INPUT_SCHEMA.properties.description,
      description: EDIT_WORKSPACE_SKILL_DESCRIPTION_DESCRIPTION,
    },
    instructions: {
      ...WORKSPACE_SKILL_AUTHORING_INPUT_SCHEMA.properties.instructions,
      description: EDIT_WORKSPACE_SKILL_INSTRUCTIONS_DESCRIPTION,
    },
    expectedBundleId: {
      type: "string",
      description:
        "The bundleId returned by workspace_skills read. Pass it to prevent overwriting a newer edit.",
    },
  },
} satisfies JSONSchema7;

export const WORKSPACE_SKILL_TOOL_CONTRACTS = [
  {
    name: WORKSPACE_SKILLS_TOOL_NAME,
    description: WORKSPACE_SKILLS_TOOL_DESCRIPTION,
    inputSchema: WORKSPACE_SKILLS_INPUT_SCHEMA,
  },
  {
    name: "create_workspace_skill",
    description: CREATE_WORKSPACE_SKILL_TOOL_DESCRIPTION,
    inputSchema: WORKSPACE_SKILL_AUTHORING_INPUT_SCHEMA,
  },
  {
    name: "edit_workspace_skill",
    description: EDIT_WORKSPACE_SKILL_TOOL_DESCRIPTION,
    inputSchema: WORKSPACE_SKILL_EDIT_INPUT_SCHEMA,
  },
] as const;

export type WorkspaceSkillToolName = (typeof WORKSPACE_SKILL_TOOL_CONTRACTS)[number]["name"];
