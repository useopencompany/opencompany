import {
  ADAPTIVE_TOOL_REGISTRY,
  ADAPTIVE_TOOL_REGISTRY_VERSION,
  adaptiveRegistryToolCount,
} from "./registry";
import type {
  ActivatedIntegration,
  ActivatedToolCard,
  ActivationReason,
  AdaptiveExposureSnapshot,
  AdaptiveIntegrationDefinition,
  AdaptiveToolDefinition,
} from "./types";

const CLAUSE_SPLIT =
  /(?:[;\n]+|\.(?=\s|$)|\bthen\b|\band\s+(?=(?:search|find|list|show|get|fetch|read|create|open|file|update|edit|send|post|notify|broadcast|reply|schedule|book|cancel|delete|add|compare|check|duplicate|copy)\b))/gi;
const WORD = /[a-z0-9][a-z0-9_-]*/g;
const MAX_TOOLS_PER_INTEGRATION = 4;
const MAX_TOOL_CARDS = 24;

const PATTERN_RULES: ReadonlyArray<{
  integrationId: string;
  label: string;
  regex: RegExp;
}> = [
  { integrationId: "slack", label: "channel handle", regex: /#[a-z][\w-]*/i },
  { integrationId: "linear", label: "issue identifier", regex: /\b[A-Z]{2,8}-\d+\b/ },
  { integrationId: "github", label: "pull-request identifier", regex: /\bPR\s*#?\d+\b/i },
  {
    integrationId: "calendar",
    label: "date or time expression",
    regex:
      /\b(?:today|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|\d{1,2}:\d{2})\b/i,
  },
];

function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

function words(value: string) {
  return new Set(normalize(value).match(WORD) ?? []);
}

function containsPhrase(haystack: string, phrase: string) {
  const normalizedPhrase = normalize(phrase);
  if (!normalizedPhrase) return false;
  if (/^[a-z0-9_-]+$/.test(normalizedPhrase)) {
    return words(haystack).has(normalizedPhrase);
  }
  return normalize(haystack).includes(normalizedPhrase);
}

export function splitAdaptiveQuery(query: string): string[] {
  const clauses = query
    .split(CLAUSE_SPLIT)
    .map((clause) => clause.trim().replace(/^,\s*/, ""))
    .filter(Boolean);
  return clauses.length ? clauses : [query.trim()];
}

function integrationReasons(
  query: string,
  integration: AdaptiveIntegrationDefinition,
): ActivationReason[] {
  const reasons: ActivationReason[] = [];
  for (const alias of [integration.id, integration.name, ...integration.aliases]) {
    if (containsPhrase(query, alias)) {
      reasons.push({ kind: "explicit", matched: alias, score: 100 });
      break;
    }
  }
  for (const keyword of integration.keywords) {
    if (containsPhrase(query, keyword)) {
      reasons.push({ kind: "keyword", matched: keyword, score: 22 });
    }
  }
  for (const rule of PATTERN_RULES) {
    if (rule.integrationId !== integration.id) continue;
    rule.regex.lastIndex = 0;
    const match = rule.regex.exec(query);
    if (match) reasons.push({ kind: "pattern", matched: `${rule.label}: ${match[0]}`, score: 45 });
  }
  return reasons;
}

function signature(tool: AdaptiveToolDefinition): string {
  const schema = tool.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  return Object.keys(schema.properties ?? {})
    .map((name) => (required.has(name) ? name : `${name}?`))
    .join(", ");
}

function lexicalOverlap(left: string, right: string) {
  const leftWords = words(left);
  const rightWords = words(right);
  let overlap = 0;
  for (const word of leftWords) {
    if (word.length > 2 && rightWords.has(word)) overlap += 1;
  }
  return overlap;
}

function scoreToolForClause(tool: AdaptiveToolDefinition, clause: string) {
  const reasons: ActivationReason[] = [];
  for (const alias of tool.operationAliases) {
    if (containsPhrase(clause, alias)) {
      reasons.push({ kind: "operation", matched: alias, score: 60 });
    }
  }
  for (const alias of tool.objectAliases) {
    if (containsPhrase(clause, alias)) {
      reasons.push({ kind: "object", matched: alias, score: 28 });
    }
  }
  const overlap = lexicalOverlap(clause, `${tool.name} ${tool.description}`);
  if (overlap > 0) {
    reasons.push({
      kind: "lexical",
      matched: `${overlap} shared term${overlap === 1 ? "" : "s"}`,
      score: overlap * 6,
    });
  }
  return { reasons, score: reasons.reduce((total, reason) => total + reason.score, 0) };
}

function selectToolCards(
  integration: AdaptiveIntegrationDefinition,
  clauses: readonly string[],
): ActivatedToolCard[] {
  const matchingClauses = clauses
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => integrationReasons(text, integration).length > 0);
  const scoringClauses = matchingClauses.length
    ? matchingClauses
    : clauses.map((text, index) => ({ text, index }));
  const scored = integration.tools.map((tool) => {
    const matchedClauses: number[] = [];
    const reasons: ActivationReason[] = [];
    let score = 0;
    for (const clause of scoringClauses) {
      const match = scoreToolForClause(tool, clause.text);
      if (match.score <= 0) continue;
      matchedClauses.push(clause.index);
      reasons.push(...match.reasons);
      score = Math.max(score, match.score);
    }
    return { tool, score, matchedClauses, reasons };
  });

  const exact = scored.filter((item) =>
    item.reasons.some((reason) => reason.kind === "operation" || reason.kind === "object"),
  );
  const selected = new Map<string, (typeof scored)[number]>();
  for (const item of exact.toSorted(compareToolScores)) {
    if (selected.size >= MAX_TOOLS_PER_INTEGRATION) break;
    selected.set(item.tool.pointer, item);
  }
  for (const item of scored.toSorted(compareToolScores)) {
    if (selected.size >= MAX_TOOLS_PER_INTEGRATION) break;
    if (item.score <= 0 && selected.size >= 2) break;
    selected.set(item.tool.pointer, item);
  }
  for (const item of scored.toSorted(
    (left, right) => right.tool.popularity - left.tool.popularity,
  )) {
    if (selected.size >= Math.min(2, integration.tools.length)) break;
    if (selected.has(item.tool.pointer)) continue;
    selected.set(item.tool.pointer, {
      ...item,
      score: Math.round(item.tool.popularity * 10),
      reasons: [
        {
          kind: "fallback",
          matched: "popular fallback",
          score: Math.round(item.tool.popularity * 10),
        },
      ],
    });
  }

  return [...selected.values()].toSorted(compareToolScores).map(({ tool, ...item }) => ({
    pointer: tool.pointer,
    name: tool.name,
    description: tool.description,
    signature: signature(tool),
    sideEffect: tool.sideEffect,
    outputKind: tool.outputKind,
    ...item,
  }));
}

function compareToolScores(
  left: { tool: AdaptiveToolDefinition; score: number },
  right: { tool: AdaptiveToolDefinition; score: number },
) {
  return (
    right.score - left.score ||
    right.tool.popularity - left.tool.popularity ||
    left.tool.pointer.localeCompare(right.tool.pointer)
  );
}

function estimateTokens(value: unknown) {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(value)).byteLength / 4);
}

function level0Shape() {
  return ADAPTIVE_TOOL_REGISTRY.map((integration) => ({
    name: integration.name,
    summary: integration.summary,
    pointer: integration.pointer,
  }));
}

function adaptiveContextShape(integrations: readonly ActivatedIntegration[]) {
  return {
    level0: level0Shape(),
    level1: integrations.map((integration) => ({
      integration: integration.id,
      pointer: integration.pointer,
      tools: integration.tools.map((tool) => ({
        pointer: tool.pointer,
        signature: `${tool.name}(${tool.signature})`,
        description: tool.description,
        sideEffect: tool.sideEffect,
        outputKind: tool.outputKind,
      })),
    })),
    engineTools: [
      "expand_integration(pointer, intent?)",
      "inspect_tool(pointer)",
      "call_tool(pointer, arguments)",
    ],
  };
}

function flatContextShape() {
  return ADAPTIVE_TOOL_REGISTRY.flatMap((integration) =>
    integration.tools.map((tool) => ({
      name: `${integration.id}__${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
      example: tool.example,
    })),
  );
}

export function analyzeAdaptiveToolQuery(query: string): AdaptiveExposureSnapshot {
  const startedAt = performance.now();
  const clauses = splitAdaptiveQuery(query);
  const activated = ADAPTIVE_TOOL_REGISTRY.map((integration) => {
    const reasons = integrationReasons(query, integration);
    if (reasons.length === 0) return null;
    const tools = selectToolCards(integration, clauses);
    return {
      id: integration.id,
      name: integration.name,
      summary: integration.summary,
      pointer: integration.pointer,
      score: reasons.reduce((total, reason) => total + reason.score, 0),
      reasons,
      tools,
    } satisfies ActivatedIntegration;
  }).filter((integration): integration is ActivatedIntegration => integration !== null);

  const integrations = activated.toSorted(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id),
  );
  let remaining = MAX_TOOL_CARDS;
  for (const integration of integrations) {
    if (integration.tools.length <= remaining) {
      remaining -= integration.tools.length;
      continue;
    }
    integration.tools = integration.tools.slice(0, Math.max(0, remaining));
    remaining = 0;
  }

  const estimatedAdaptiveTokens = estimateTokens(adaptiveContextShape(integrations));
  const estimatedFlatTokens = estimateTokens(flatContextShape());
  return {
    registryVersion: ADAPTIVE_TOOL_REGISTRY_VERSION,
    query,
    clauses,
    integrationCount: ADAPTIVE_TOOL_REGISTRY.length,
    registryToolCount: adaptiveRegistryToolCount(),
    activatedIntegrationCount: integrations.length,
    candidateToolCount: integrations.reduce(
      (total, integration) => total + integration.tools.length,
      0,
    ),
    activationLatencyMs: performance.now() - startedAt,
    estimatedAdaptiveTokens,
    estimatedFlatTokens,
    estimatedReductionPercent:
      estimatedFlatTokens === 0
        ? 0
        : ((estimatedFlatTokens - estimatedAdaptiveTokens) / estimatedFlatTokens) * 100,
    level0: ADAPTIVE_TOOL_REGISTRY.map((integration) => ({
      id: integration.id,
      name: integration.name,
      summary: integration.summary,
      pointer: integration.pointer,
      activated: integrations.some((item) => item.id === integration.id),
    })),
    integrations,
  };
}

export function renderAdaptiveLevel0() {
  return ADAPTIVE_TOOL_REGISTRY.map(
    (integration) => `- ${integration.name}: ${integration.summary} [${integration.pointer}]`,
  ).join("\n");
}

export function renderAdaptiveLevel1(snapshot: AdaptiveExposureSnapshot) {
  if (snapshot.integrations.length === 0) {
    return "(No integrations auto-activated. Follow a Level-0 integration pointer if the request needs tools.)";
  }
  return snapshot.integrations
    .map((integration) =>
      [
        `${integration.name} [${integration.pointer}]`,
        ...integration.tools.map(
          (tool) =>
            `- ${tool.name}(${tool.signature}): ${tool.description} Returns ${tool.outputKind}. [${tool.pointer}]`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
}
