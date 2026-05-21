import type {
  AgentConfig,
  AgentConfigTool,
  AgentFile,
  AgentModelId,
  AgentToolId,
} from "./types";
import { SUPPORTED_AGENT_MODELS, SUPPORTED_AGENT_TOOLS } from "./config";

const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";
const MODEL_BY_ID = new Map(SUPPORTED_AGENT_MODELS.map((model) => [model.id, model]));
const TOOL_BY_ID = new Map(SUPPORTED_AGENT_TOOLS.map((tool) => [tool.id, tool]));

type Frontmatter = {
  title?: string;
  model?: string;
  tools?: string[];
};

export function parseAgentFile(source: string): AgentFile {
  const { frontmatter, body } = splitFrontmatter(source);
  const title = normalizeTitle(frontmatter.title ?? "Untitled agent");
  const model = normalizeModelId(frontmatter.model ?? DEFAULT_MODEL_ID);
  const tools = normalizeTools(frontmatter.tools ?? []);

  return {
    title,
    body,
    config: buildAgentConfig({ title, body, model, tools }),
  };
}

export function serializeAgentFile(input: {
  title: string;
  body: string;
  model?: AgentModelId;
  tools?: AgentToolId[];
}) {
  const title = normalizeTitle(input.title);
  const body = normalizeBody(input.body);
  const fromMentions = extractConfigFromMentions(body);
  const model = input.model ?? fromMentions.model;
  const tools = input.tools ?? fromMentions.tools;

  return [
    "---",
    `title: ${quoteYamlString(title)}`,
    `model: ${model}`,
    "tools:",
    ...tools.map((tool) => `  - ${tool}`),
    "---",
    "",
    body,
  ].join("\n");
}

export function buildAgentFile(input: { title: string; body: string }): AgentFile {
  const body = normalizeBody(input.body);
  const mentioned = extractConfigFromMentions(body);
  const title = normalizeTitle(input.title);

  return {
    title,
    body,
    config: buildAgentConfig({
      title,
      body,
      model: mentioned.model,
      tools: mentioned.tools,
    }),
  };
}

export function extractConfigFromMentions(body: string): {
  model: AgentModelId;
  tools: AgentToolId[];
} {
  let model = DEFAULT_MODEL_ID;
  const tools = new Set<AgentToolId>();

  for (const rawId of extractMentionIds(body)) {
    const modelId = mentionModelId(rawId);
    if (modelId) {
      model = modelId;
      continue;
    }

    if (TOOL_BY_ID.has(rawId as AgentToolId)) {
      tools.add(rawId as AgentToolId);
    }
  }

  return { model, tools: Array.from(tools) };
}

export function extractMentionIds(body: string) {
  const ids: string[] = [];

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "@") continue;
    let end = index + 1;
    while (end < body.length && isMentionChar(body[end] ?? "")) {
      end += 1;
    }
    const id = body.slice(index + 1, end).replace(/[.,;:!?)}\]]+$/g, "");
    if (id) ids.push(id);
    index = end;
  }

  return ids;
}

export function slugifyAgentTitle(title: string) {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "untitled-agent";
}

export function agentPathForSlug(slug: string) {
  return `agents/${slug}.agent`;
}

export function normalizeAgentPath(path: string) {
  const trimmed = path.trim().replace(/^\/+/, "");
  if (!trimmed.startsWith("agents/") || !trimmed.endsWith(".agent")) {
    throw new Error("Agent path must match agents/<slug>.agent.");
  }
  return trimmed;
}

export function legacyModelId(id: string): AgentModelId {
  return normalizeModelId(id);
}

function buildAgentConfig(input: {
  title: string;
  body: string;
  model: AgentModelId;
  tools: AgentToolId[];
}): AgentConfig {
  return {
    schemaVersion: "agent.v1",
    title: input.title,
    instructions: input.body,
    model: {
      provider: "vercel-ai-gateway",
      name: input.model,
    },
    tools: input.tools.flatMap((id): AgentConfigTool[] => {
      const tool = TOOL_BY_ID.get(id);
      return tool ? [{ ...tool }] : [];
    }),
  };
}

function splitFrontmatter(source: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: normalized };
  }

  const yaml = normalized.slice(4, end);
  const bodyStart = normalized.slice(end + 4).replace(/^\n+/, "");
  return {
    frontmatter: parseFrontmatter(yaml),
    body: bodyStart,
  };
}

function parseFrontmatter(yaml: string): Frontmatter {
  const frontmatter: Frontmatter = {};
  const lines = yaml.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.trim() || line.trimStart().startsWith("#")) continue;

    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue = ""] = match;

    if (key === "title") {
      frontmatter.title = unquoteYamlString(rawValue);
      continue;
    }

    if (key === "model") {
      frontmatter.model = unquoteYamlString(rawValue);
      continue;
    }

    if (key === "tools") {
      const inline = rawValue.trim();
      if (inline.startsWith("[") && inline.endsWith("]")) {
        frontmatter.tools = inline
          .slice(1, -1)
          .split(",")
          .map((item) => unquoteYamlString(item.trim()))
          .filter(Boolean);
        continue;
      }

      const tools: string[] = [];
      while (lines[index + 1]?.startsWith("  - ")) {
        index += 1;
        tools.push(unquoteYamlString((lines[index] ?? "").slice("  - ".length)));
      }
      frontmatter.tools = tools;
    }
  }

  return frontmatter;
}

function normalizeTitle(title: string) {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled agent";
}

function normalizeBody(body: string) {
  return body.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
}

function normalizeModelId(id: string): AgentModelId {
  if (id === "default" || id === "fast") return "openai/gpt-5.4-mini";
  if (id === "deep") return "openai/gpt-5.4";
  return MODEL_BY_ID.has(id as AgentModelId) ? (id as AgentModelId) : DEFAULT_MODEL_ID;
}

function mentionModelId(id: string): AgentModelId | null {
  if (id === "default" || id === "fast") return "openai/gpt-5.4-mini";
  if (id === "deep") return "openai/gpt-5.4";
  return MODEL_BY_ID.has(id as AgentModelId) ? (id as AgentModelId) : null;
}

function normalizeTools(ids: string[]) {
  const tools = new Set<AgentToolId>();
  for (const id of ids) {
    if (TOOL_BY_ID.has(id as AgentToolId)) tools.add(id as AgentToolId);
  }
  return Array.from(tools);
}

function isMentionChar(char: string) {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "_" ||
    char === "." ||
    char === "/" ||
    char === "-"
  );
}

function quoteYamlString(value: string) {
  return JSON.stringify(value);
}

function unquoteYamlString(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      if (trimmed.startsWith('"')) return JSON.parse(trimmed);
      return trimmed.slice(1, -1).replace(/''/g, "'");
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}
