import {
  GOAT_BRAIN_MARKDOWN_MIME_TYPE,
  type GoatBrainEntry,
  goatBrainEntryFromLegacyMarkdown,
} from "./entry";
import { checkGoatBrainHealth, type GoatBrainHealthReport } from "./health";
import type { Gateway } from "./retrieval/gateway";
import {
  type GoatBrainEntityType,
  type GoatBrainRelation,
  isValidGoatBrainRelationType,
  normalizeGoatBrainId,
} from "./schema";
import { goatBrainFolderForEntityType, normalizeBuiltInGoatBrainEntityType } from "./schemas";
import { findGoatBrainFile, listGoatBrainFiles, writeGoatBrainEntry } from "./store";
import { nowIso } from "./time";
import { goatBrainTimelineEntryFromParts } from "./timeline";
import { parseGoatBrainWikiLinks } from "./wiki-links";

type IngestGateway = Pick<Gateway, "chat">;

export type GoatBrainIngestOptions = {
  text: string;
  sourceRef: string;
  sourceTitle?: string;
  at?: string;
  dryRun?: boolean;
};

export type GoatBrainIngestAppliedChange = {
  action: "create" | "update";
  id: string;
  path: string;
  type: GoatBrainEntityType;
};

export type GoatBrainIngestResult = {
  dryRun: boolean;
  applied: GoatBrainIngestAppliedChange[];
  schemaSuggestion: null;
  health: GoatBrainHealthReport | null;
  plan: NormalizedIngestOperation[];
};

type RawIngestPlan = {
  operations?: unknown;
};

type RawIngestOperation = {
  action?: unknown;
  id?: unknown;
  title?: unknown;
  type?: unknown;
  aliases?: unknown;
  body?: unknown;
  timelineBody?: unknown;
  relations?: unknown;
  tags?: unknown;
};

export type NormalizedIngestOperation = {
  action: "create" | "update";
  id: string;
  title: string;
  type: GoatBrainEntityType;
  aliases: string[];
  body: string;
  timelineBody: string;
  relations: GoatBrainRelation[];
  tags: string[];
};

export async function ingestGoatBrain(
  root: string,
  options: GoatBrainIngestOptions,
  gateway: IngestGateway,
): Promise<GoatBrainIngestResult> {
  const text = options.text.trim();
  if (!text) throw new Error("Ingest text must not be empty.");
  const sourceRef = options.sourceRef.trim();
  if (!sourceRef) throw new Error("Ingest source ref must not be empty.");
  const at = normalizeIso(options.at) ?? nowIso();
  const existing = await loadExistingEntries(root);
  const prompt = buildIngestPrompt({
    text,
    sourceRef,
    ...(options.sourceTitle ? { sourceTitle: options.sourceTitle } : {}),
    at,
    existing,
  });
  const firstResponse = await gateway.chat(prompt);
  let plan = normalizePlan(firstResponse, { existing, fallbackText: text });
  if (!plan.ok) {
    const repairPrompt = buildRepairPrompt({
      originalPrompt: prompt,
      invalidResponse: firstResponse,
      errors: plan.errors,
    });
    plan = normalizePlan(await gateway.chat(repairPrompt), { existing, fallbackText: text });
  }
  if (!plan.ok) throw new Error(`Brain ingest plan was invalid: ${plan.errors.join(" ")}`);

  const applied: GoatBrainIngestAppliedChange[] = [];
  if (!options.dryRun) {
    for (const operation of plan.operations) {
      applied.push(
        await applyIngestOperation(root, operation, {
          at,
          sourceRef,
          ...(options.sourceTitle ? { sourceTitle: options.sourceTitle } : {}),
        }),
      );
    }
  }

  const health = options.dryRun ? null : await checkGoatBrainHealth(root);
  return {
    dryRun: Boolean(options.dryRun),
    applied,
    schemaSuggestion: null,
    health,
    plan: plan.operations,
  };
}

async function loadExistingEntries(root: string) {
  const files = await listGoatBrainFiles(root);
  return files.flatMap((file) => {
    try {
      const entry = goatBrainEntryFromLegacyMarkdown(file.source);
      return [{ file, entry }];
    } catch {
      return [];
    }
  });
}

function buildIngestPrompt(input: {
  text: string;
  sourceRef: string;
  sourceTitle?: string;
  at: string;
  existing: Array<{ entry: GoatBrainEntry }>;
}) {
  const docs = input.existing
    .map(
      ({ entry }) =>
        `- id=${entry.id}; title=${entry.title}; type=${entry.type}; aliases=${entry.aliases.join(", ")}; summary=${entry.body.slice(0, 500).replace(/\s+/g, " ")}`,
    )
    .join("\n");
  return [
    "You are the controlled ingestion loop for Goat Brain, a durable graph of user-owned knowledge.",
    "Return only JSON. Do not include markdown fences.",
    "Use existing ids when information belongs to an existing entity. Create a new entry only when no existing entry is the primary home.",
    "Use only these types: person, company, project, decision, meeting, conversation, research, document, concept, reference, daily, note.",
    "Prefer relations over extra structured fields. People, companies, projects, meetings, decisions, and sources should connect through relations.",
    "Use wiki links like [[brain-id]] or [[brain-id|Label]] only for existing or planned ids.",
    "Compiled truth is the current synthesis for the entity. Rewrite it as the durable state of play, not as a chronological log.",
    "Timeline entries are append-only evidence. `timelineBody` must be a concise factual event from this source, not a restatement of the full source text.",
    "Every timeline entry must preserve source context; the system will attach the source ref, so make `timelineBody` say what happened and why it matters.",
    "",
    "JSON shape:",
    '{"operations":[{"action":"create|update","id":"brain-id","title":"Title","type":"person|company|project|decision|meeting|conversation|research|document|concept|reference|daily|note","aliases":[],"body":"durable markdown body","timelineBody":"dated evidence summary","relations":[{"type":"related","to":"other-id"}],"tags":[]}]}',
    "",
    `Existing entries:\n${docs || "(none)"}`,
    "",
    `Source ref: ${input.sourceRef}`,
    input.sourceTitle ? `Source title: ${input.sourceTitle}` : "",
    `Captured at: ${input.at}`,
    "",
    `Text to ingest:\n${input.text}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRepairPrompt(input: {
  originalPrompt: string;
  invalidResponse: string;
  errors: string[];
}) {
  return [
    "Repair the prior Goat Brain ingest response. Return only valid JSON matching the requested shape.",
    `Errors:\n${input.errors.map((error) => `- ${error}`).join("\n")}`,
    "",
    `Original prompt:\n${input.originalPrompt}`,
    "",
    `Invalid response:\n${input.invalidResponse}`,
  ].join("\n");
}

function normalizePlan(
  text: string,
  input: { existing: Array<{ entry: GoatBrainEntry }>; fallbackText: string },
): { ok: true; operations: NormalizedIngestOperation[] } | { ok: false; errors: string[] } {
  const raw = parseJsonObject(text);
  if (!raw) return { ok: false, errors: ["Response was not a JSON object."] };
  const operations = Array.isArray((raw as RawIngestPlan).operations)
    ? ((raw as RawIngestPlan).operations as unknown[])
    : [];
  if (operations.length === 0) return { ok: false, errors: ["Plan must contain operations."] };

  const knownIds = new Set(input.existing.map(({ entry }) => entry.id));
  const plannedIds = new Set<string>();
  const errors: string[] = [];
  const normalized = operations.flatMap((operation): NormalizedIngestOperation[] => {
    const item = isRecord(operation) ? (operation as RawIngestOperation) : {};
    const title = stringValue(item.title) || "Brain note";
    const type = normalizeBuiltInGoatBrainEntityType(stringValue(item.type)) ?? "note";
    const action =
      item.action === "update" && knownIds.has(stringValue(item.id)) ? "update" : "create";
    const id = normalizeGoatBrainId(stringValue(item.id) || title) || "brain-note";
    const body = stringValue(item.body) || input.fallbackText;
    const relations = normalizeRelations(item.relations);
    plannedIds.add(id);
    return [
      {
        action,
        id,
        title,
        type,
        aliases: stringArray(item.aliases),
        body,
        timelineBody: stringValue(item.timelineBody) || "Captured source information.",
        relations,
        tags: stringArray(item.tags),
      },
    ];
  });

  const allKnownIds = new Set([...knownIds, ...plannedIds]);
  for (const operation of normalized) {
    for (const relation of operation.relations) {
      if (!isValidGoatBrainRelationType(relation.type)) {
        errors.push(`Relation type "${relation.type}" for "${operation.id}" is invalid.`);
      }
      if (!allKnownIds.has(relation.to)) {
        errors.push(`Relation target "${relation.to}" for "${operation.id}" does not exist.`);
      }
    }
    for (const link of parseGoatBrainWikiLinks(operation.body)) {
      if (!link.valid) errors.push(`Wiki link target "${link.target}" is invalid.`);
      if (link.valid && !allKnownIds.has(link.target)) {
        errors.push(`Wiki link target "${link.target}" for "${operation.id}" does not exist.`);
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, operations: normalized };
}

async function applyIngestOperation(
  root: string,
  operation: NormalizedIngestOperation,
  source: { at: string; sourceRef: string; sourceTitle?: string },
): Promise<GoatBrainIngestAppliedChange> {
  const existing = await findGoatBrainFile(root, operation.id);
  const existingEntry = existing ? goatBrainEntryFromLegacyMarkdown(existing.source) : null;
  const entry: GoatBrainEntry = {
    ...(existingEntry ?? {
      id: operation.id,
      folder: goatBrainFolderForEntityType(operation.type),
      createdAt: source.at,
      kind: "markdown" as const,
      mimeType: GOAT_BRAIN_MARKDOWN_MIME_TYPE,
      relations: [],
      sources: [],
      tags: [],
      status: "draft" as const,
      timeline: [],
    }),
    id: operation.id,
    title: operation.title,
    type: operation.type,
    aliases: operation.aliases,
    body: operation.body,
    updatedAt: source.at,
  };
  entry.relations = mergeRelations(entry.relations, operation.relations);
  entry.sources = mergeSources(entry.sources, {
    ref: source.sourceRef,
    capturedAt: source.at,
    ...(source.sourceTitle ? { title: source.sourceTitle } : {}),
  });
  entry.tags = mergeStrings(entry.tags, operation.tags);
  entry.timeline = [
    ...entry.timeline,
    goatBrainTimelineEntryFromParts({
      at: source.at,
      summary: operation.timelineBody,
      sourceRef: source.sourceRef,
      sourceTitle: source.sourceTitle ?? "",
    }),
  ];
  const path = await writeGoatBrainEntry(root, entry);
  return { action: existingEntry ? "update" : "create", id: entry.id, path, type: entry.type };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeRelations(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): GoatBrainRelation[] => {
    if (!isRecord(item)) return [];
    const to = normalizeGoatBrainId(stringValue(item.to));
    const type = stringValue(item.type) || "related";
    if (!to || seen.has(`${type}:${to}`)) return [];
    seen.add(`${type}:${to}`);
    return [{ type, to }];
  });
}

function mergeRelations(current: GoatBrainRelation[], next: GoatBrainRelation[]) {
  const byKey = new Map(current.map((relation) => [`${relation.type}:${relation.to}`, relation]));
  for (const relation of next) byKey.set(`${relation.type}:${relation.to}`, relation);
  return [...byKey.values()].sort((a, b) => a.to.localeCompare(b.to));
}

function mergeSources(
  current: GoatBrainEntry["sources"],
  source: GoatBrainEntry["sources"][number],
) {
  if (current.some((item) => item.ref === source.ref)) return current;
  return [...current, source];
}

function mergeStrings(current: string[], next: string[]) {
  return [...new Set([...current, ...next].filter((value) => value.trim()))];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIso(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
