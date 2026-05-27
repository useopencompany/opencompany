import {
  type AgentConfigDerivationRepository,
  deriveAgentConfigFromBody,
  SUPPORTED_AGENT_MODELS,
  SUPPORTED_AGENT_TOOLS,
} from "@opencompany/agent-runtime";
import type {
  AgentConfig,
  AgentModelId,
  AgentTriggerConfig,
  TiptapDoc,
} from "@opencompany/agent-runtime/types";
import { asRecord, sanitizeTiptapDoc, type TiptapNode } from "./tiptap";

const TOOL_ID_BY_LABEL = new Map(
  SUPPORTED_AGENT_TOOLS.map((tool) => [tool.label.toLowerCase(), tool.id]),
);
const MODEL_ID_BY_LABEL = new Map(
  SUPPORTED_AGENT_MODELS.map((model) => [model.label.toLowerCase(), model.id]),
);

export { SUPPORTED_AGENT_MODELS, SUPPORTED_AGENT_TOOLS } from "@opencompany/agent-runtime";

export function derivePreviewConfigFromTiptapDoc(input: {
  title: string;
  content: unknown;
  model?: AgentModelId;
  repositories: AgentConfigDerivationRepository[];
  triggers?: AgentTriggerConfig[];
}): { body: string; config: AgentConfig } {
  const content = sanitizeTiptapDoc(input.content);
  const body = extractPlainText(content);

  return deriveAgentConfigFromBody({
    title: input.title,
    body,
    repositories: input.repositories,
    ...(input.model ? { model: input.model } : {}),
    ...(input.triggers ? { triggers: input.triggers } : {}),
  });
}

function extractPlainText(doc: TiptapDoc) {
  const blocks = (doc.content ?? [])
    .map((node) => nodeText(node as TiptapNode).trim())
    .filter(Boolean);

  return blocks.join("\n\n");
}

function nodeText(node: TiptapNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") {
    const attrs = asRecord(node.attrs);
    const display = mentionDisplayText(attrs);
    const char =
      typeof attrs?.mentionSuggestionChar === "string" ? attrs.mentionSuggestionChar : "@";
    return display ? `${char}${display}` : "";
  }
  return (node.content ?? []).map(nodeText).join("");
}

function mentionDisplayText(attrs: Record<string, unknown> | null) {
  const id = typeof attrs?.id === "string" ? attrs.id.trim() : "";
  if (id.startsWith("tool:")) return id.slice("tool:".length);
  if (id.startsWith("model:")) return id.slice("model:".length);
  if (id.startsWith("brain/")) return id;
  if (id.startsWith("integration:github:")) {
    const label = typeof attrs?.label === "string" ? attrs.label.trim() : "";
    return label || id.slice("integration:github:".length);
  }
  if (id === "integration:github") return "github";
  if (id === "after-session") return "after-session";

  const label = typeof attrs?.label === "string" ? attrs.label.trim() : "";
  const normalizedLabel = label.toLowerCase();
  return (
    TOOL_ID_BY_LABEL.get(normalizedLabel) ?? MODEL_ID_BY_LABEL.get(normalizedLabel) ?? (label || id)
  );
}
