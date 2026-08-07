import {
  type BrainEntry,
  brainEntryFromLegacyMarkdown,
  GOAT_BRAIN_MARKDOWN_MIME_TYPE,
} from "./entry";
import { type BrainHealthReport, checkBrainHealth } from "./health";
import { GOAT_BRAIN_POINTER_COPY_RULE } from "./pointer-copy";
import type { Gateway } from "./retrieval/gateway";
import {
  type BrainEntityType,
  type BrainRelation,
  type BrainTimelineEntry,
  isValidBrainRelationType,
  normalizeBrainId,
} from "./schema";
import { defaultBrainFolder, normalizeBuiltInBrainEntityType } from "./schemas";
import { findBrainFile, listBrainFiles, writeBrainEntry } from "./store";
import { nowIso } from "./time";
import { brainTimelineEntryFromParts, brainTimelinePartsFromEntry } from "./timeline";
import { parseBrainWikiLinks } from "./wiki-links";

type IngestGateway = Pick<Gateway, "chat">;

export type BrainIngestOptions = {
  text: string;
  sourceRef: string;
  sourceTitle?: string;
  at?: string;
  dryRun?: boolean;
};

export type BrainIngestAppliedChange = {
  action: "create" | "update";
  id: string;
  path: string;
  type: BrainEntityType;
};

export type BrainIngestFailedChange = {
  action: "create" | "update";
  id: string;
  type: BrainEntityType;
  error: string;
};

export type BrainIngestResult = {
  dryRun: boolean;
  applied: BrainIngestAppliedChange[];
  failed: BrainIngestFailedChange[];
  schemaSuggestion: null;
  health: BrainHealthReport | null;
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
};

export type NormalizedIngestOperation = {
  action: "create" | "update";
  id: string;
  title: string;
  type: BrainEntityType;
  aliases: string[];
  body: string;
  timelineBody: string;
  relations: BrainRelation[];
};

export async function ingestBrain(
  root: string,
  options: BrainIngestOptions,
  gateway: IngestGateway,
): Promise<BrainIngestResult> {
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

  const applied: BrainIngestAppliedChange[] = [];
  const failed: BrainIngestFailedChange[] = [];
  if (!options.dryRun) {
    for (const operation of plan.operations) {
      try {
        applied.push(
          await applyIngestOperation(root, operation, {
            at,
            sourceRef,
            ...(options.sourceTitle ? { sourceTitle: options.sourceTitle } : {}),
          }),
        );
      } catch (error) {
        failed.push({
          action: operation.action,
          id: operation.id,
          type: operation.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const health = options.dryRun ? null : await checkBrainHealth(root);
  return {
    dryRun: Boolean(options.dryRun),
    applied,
    failed,
    schemaSuggestion: null,
    health,
    plan: plan.operations,
  };
}

async function loadExistingEntries(root: string) {
  const files = await listBrainFiles(root);
  return files.flatMap((file) => {
    try {
      const entry = brainEntryFromLegacyMarkdown(file.source);
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
  existing: Array<{ entry: BrainEntry }>;
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
    "Use only these types: person, company, project, meeting, concept, source, analysis, note. External artifacts (articles, videos, email threads, repos) are `source`; synthesized prose is `analysis`.",
    "Prefer relations over extra structured fields. People, companies, projects, and sources should connect through relations.",
    "Use inline links like [[page:brain-id|Label]] for pages, [[evidence:ev-id|Label]] for evidence, and [[source:provider:id|Label]] for source refs. Legacy [[brain-id|Label]] page links are accepted but new content should use typed links.",
    GOAT_BRAIN_POINTER_COPY_RULE,
    "Compiled truth is the current synthesis for the entity. Rewrite it as the durable state of play, not as a chronological log.",
    "Timeline entries are append-only evidence. `timelineBody` must be a concise factual event from this source, not a restatement of the full source text.",
    "Every timeline entry must preserve source context; the system will attach the source ref, so make `timelineBody` say what happened and why it matters.",
    "",
    "JSON shape:",
    '{"operations":[{"action":"create|update","id":"brain-id","title":"Title","type":"person|company|project|meeting|concept|source|analysis|note","aliases":[],"body":"durable markdown body","timelineBody":"dated evidence summary","relations":[{"type":"related","to":"other-id"}]}]}',
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
  input: { existing: Array<{ entry: BrainEntry }>; fallbackText: string },
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
    const type = normalizeBuiltInBrainEntityType(stringValue(item.type)) ?? "note";
    const id = normalizeBrainId(stringValue(item.id) || title) || "brain-note";
    const action = item.action === "update" && knownIds.has(id) ? "update" : "create";
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
      },
    ];
  });

  const allKnownIds = new Set([...knownIds, ...plannedIds]);
  for (const operation of normalized) {
    for (const relation of operation.relations) {
      if (!isValidBrainRelationType(relation.type)) {
        errors.push(`Relation type "${relation.type}" for "${operation.id}" is invalid.`);
      }
      if (!allKnownIds.has(relation.to)) {
        errors.push(`Relation target "${relation.to}" for "${operation.id}" does not exist.`);
      }
    }
    for (const link of parseBrainWikiLinks(operation.body)) {
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
): Promise<BrainIngestAppliedChange> {
  const existing = await findBrainFile(root, operation.id);
  const existingEntry = existing ? brainEntryFromLegacyMarkdown(existing.source) : null;
  // The one-shot planner only writes working pages; evidence docs are captured
  // by dedicated ingestion paths. Folders are navigation: keep the existing
  // placement on update and fall back to the type's default for new docs.
  const folder = existingEntry?.folder ?? defaultBrainFolder(operation.type, "page");
  const entry: BrainEntry = {
    ...(existingEntry ?? {
      id: operation.id,
      createdAt: source.at,
      format: "markdown" as const,
      mimeType: GOAT_BRAIN_MARKDOWN_MIME_TYPE,
      relations: [],
      sources: [],
      status: "draft" as const,
      timeline: [],
    }),
    id: operation.id,
    folder,
    kind: existingEntry?.kind ?? "page",
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
  const timelineEntry = brainTimelineEntryFromParts({
    at: source.at,
    summary: operation.timelineBody,
    sourceRef: source.sourceRef,
    sourceTitle: source.sourceTitle ?? "",
  });
  if (!entry.timeline.some((entry) => isDuplicateTimelineEntry(entry, timelineEntry))) {
    entry.timeline = [...entry.timeline, timelineEntry];
  }
  const path = await writeBrainEntry(root, entry);
  return { action: existingEntry ? "update" : "create", id: entry.id, path, type: entry.type };
}

function isDuplicateTimelineEntry(current: BrainTimelineEntry, next: BrainTimelineEntry): boolean {
  if (current.evidenceId === next.evidenceId) return true;
  const currentParts = brainTimelinePartsFromEntry(current);
  const nextParts = brainTimelinePartsFromEntry(next);
  if (!currentParts || !nextParts || !currentParts.sourceRef) return false;
  return currentParts.sourceRef === nextParts.sourceRef && currentParts.at === nextParts.at;
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
  return value.flatMap((item): BrainRelation[] => {
    if (!isRecord(item)) return [];
    const to = normalizeBrainId(stringValue(item.to));
    const type = stringValue(item.type) || "related";
    if (!to || seen.has(`${type}:${to}`)) return [];
    seen.add(`${type}:${to}`);
    return [{ type, to }];
  });
}

function mergeRelations(current: BrainRelation[], next: BrainRelation[]) {
  const byKey = new Map(current.map((relation) => [`${relation.type}:${relation.to}`, relation]));
  for (const relation of next) byKey.set(`${relation.type}:${relation.to}`, relation);
  return [...byKey.values()].sort((a, b) => a.to.localeCompare(b.to));
}

function mergeSources(current: BrainEntry["sources"], source: BrainEntry["sources"][number]) {
  if (current.some((item) => item.ref === source.ref)) return current;
  return [...current, source];
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
