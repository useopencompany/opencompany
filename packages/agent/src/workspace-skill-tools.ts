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
  command: "list" | "read" | "archive" | "set_scope";
  scope?: "personal" | "company";
  expectedScope?: "personal" | "company";
  name?: string;
};

export const WORKSPACE_SKILLS_TOOL_NAME = "workspace_skills";
export const WORKSPACE_SKILLS_TOOL_DESCRIPTION =
  "Manage installed standalone Skills in the active workspace. list includes your Personal skills and Company skills with IDs, scope, source, and edit/manage permissions. set_scope changes the same skill between personal and company; only the creator or an admin can change Company visibility or archive it. Personal skills are visible only to their creator. Share only when the user asks, and explain that instructions and bundled files become accessible to everyone. read requires a Skill ID or unambiguous name and returns the latest saved description and Markdown instructions without activating the Skill; use this before editing, even if a chat already has an older version loaded. archive requires a Skill ID or unambiguous name and removes that installation from future selection while preserving existing chat and task snapshots. Archive only when the user has asked to remove, delete, or archive that Skill. Plugin Skills are managed through their Plugin. Use create_workspace_skill to add a Skill and edit_workspace_skill to change a Skill’s name/slash command, description, or instructions.";
export const WORKSPACE_SKILLS_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: { type: "string", enum: ["personal", "company"] },
    expectedScope: {
      type: "string",
      enum: ["personal", "company"],
      description: "Current scope from read; required for set_scope.",
    },
    command: { type: "string", enum: ["list", "read", "archive", "set_scope"] },
    name: {
      type: "string",
      description:
        "Skill ID from list/read, or an unambiguous name. Required for read, archive, and set_scope.",
    },
  },
  required: ["command"],
} satisfies JSONSchema7;

export const WORKSPACE_SKILL_AUTHORING_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: {
      type: "string",
      enum: ["personal", "company"],
      description:
        "Defaults to personal. Use company only when the user asks to share with everyone in the workspace.",
    },
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

const { scope: _creationScope, ...editProperties } =
  WORKSPACE_SKILL_AUTHORING_INPUT_SCHEMA.properties;

export const WORKSPACE_SKILL_EDIT_INPUT_SCHEMA = {
  ...WORKSPACE_SKILL_AUTHORING_INPUT_SCHEMA,
  properties: {
    ...editProperties,
    name: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: EDIT_WORKSPACE_SKILL_NAME_DESCRIPTION,
    },
    newName: {
      ...WORKSPACE_SKILL_AUTHORING_INPUT_SCHEMA.properties.name,
      description:
        "Optional new lowercase kebab-case name (without /). Also changes the slash command and @skill handle; the installation ID stays the same.",
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
  // Anthropic rejects top-level schema combinators before generation. The Skill
  // update service enforces that at least one editable field is supplied.
  required: ["name"],
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
