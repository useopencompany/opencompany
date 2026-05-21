import type { AgentConfig, AgentModelId, AgentToolId, TiptapDoc } from "./types";
import { asRecord, sanitizeTiptapDoc, type TiptapNode } from "./tiptap";

type AgentToolDefinition = {
  id: AgentToolId;
  type: "tool";
  label: string;
  description: string;
};

type AgentModelDefinition = {
  id: AgentModelId;
  type: "model";
  label: string;
  description: string;
};

export const SUPPORTED_AGENT_TOOLS: AgentToolDefinition[] = [
  {
    id: "exa",
    type: "tool",
    label: "exa",
    description: "Deep research on the web and people.",
  },
];

export const SUPPORTED_AGENT_MODELS: AgentModelDefinition[] = [
  {
    id: "openai/gpt-5.4-mini",
    type: "model",
    label: "openai/gpt-5.4-mini",
    description: "Cost-efficient GPT model for agentic production work.",
  },
  {
    id: "openai/gpt-5.4",
    type: "model",
    label: "openai/gpt-5.4",
    description: "Highly capable GPT model for complex reasoning and workflows.",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    type: "model",
    label: "anthropic/claude-haiku-4.5",
    description: "Cost-efficient Claude model for fast agent workloads.",
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    type: "model",
    label: "anthropic/claude-sonnet-4.6",
    description: "Highly capable Claude model for coding and professional work.",
  },
];

const TOOL_BY_ID = new Map(SUPPORTED_AGENT_TOOLS.map((tool) => [tool.id, tool]));
const MODEL_BY_ID = new Map(SUPPORTED_AGENT_MODELS.map((model) => [model.id, model]));

export function extractAgentConfig(input: {
  name: string;
  content: TiptapDoc;
}): AgentConfig {
  const content = sanitizeTiptapDoc(input.content);
  const model = collectMentionedModel(content);

  return {
    schemaVersion: "agent.v1",
    title: normalizeName(input.name),
    instructions: extractPlainText(content),
    model: {
      provider: "vercel-ai-gateway",
      name: model.id,
    },
    tools: collectMentionedTools(content).map((tool) => ({ ...tool })),
  };
}

function normalizeName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "Untitled agent";
}

function collectMentionedTools(doc: TiptapDoc) {
  const seen = new Set<string>();
  const tools: AgentToolDefinition[] = [];

  walk(doc as TiptapNode, (node) => {
    const mention = parseMention(node);
    if (mention?.type !== "tool") return;
    const tool = TOOL_BY_ID.get(mention.id as AgentToolId);
    if (!tool || seen.has(tool.id)) return;
    seen.add(tool.id);
    tools.push(tool);
  });

  return tools;
}

function collectMentionedModel(doc: TiptapDoc) {
  let selected = MODEL_BY_ID.get("openai/gpt-5.4-mini")!;

  walk(doc as TiptapNode, (node) => {
    const mention = parseMention(node);
    if (mention?.type !== "model") return;
    selected = MODEL_BY_ID.get(mention.id as AgentModelId) ?? selected;
  });

  return selected;
}

function parseMention(node: TiptapNode) {
  if (node.type !== "mention") return null;
  const attrs = asRecord(node.attrs);
  const rawId = typeof attrs?.id === "string" ? attrs.id : null;
  if (!rawId) return null;

  if (rawId.startsWith("tool:")) {
    return { type: "tool" as const, id: rawId.slice("tool:".length) };
  }

  if (rawId.startsWith("model:")) {
    return { type: "model" as const, id: normalizeModelId(rawId.slice("model:".length)) };
  }

  if (TOOL_BY_ID.has(rawId as AgentToolId)) {
    return { type: "tool" as const, id: rawId };
  }

  const modelId = normalizeModelId(rawId);
  if (MODEL_BY_ID.has(modelId as AgentModelId)) {
    return { type: "model" as const, id: modelId };
  }

  return null;
}

function normalizeModelId(id: string) {
  if (id === "default" || id === "fast") return "openai/gpt-5.4-mini";
  if (id === "deep") return "openai/gpt-5.4";
  return id;
}

function extractPlainText(doc: TiptapDoc) {
  const blocks = (doc.content ?? [])
    .map((node) => nodeText(node as TiptapNode).trim())
    .filter(Boolean);

  return blocks.join("\n\n");
}

function nodeText(node: TiptapNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "mention") {
    const attrs = asRecord(node.attrs);
    const label = typeof attrs?.label === "string" ? attrs.label : null;
    const id = typeof attrs?.id === "string" ? attrs.id : null;
    return `@${label ?? id ?? ""}`;
  }
  return (node.content ?? []).map(nodeText).join("");
}

function walk(node: TiptapNode, visit: (node: TiptapNode) => void) {
  visit(node);
  node.content?.forEach((child) => walk(child, visit));
}
