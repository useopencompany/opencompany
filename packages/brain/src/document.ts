import { parseFrontmatter, serializeFrontmatter, splitFrontmatter } from "./frontmatter";
import { parseGoatBrainInlineLinks } from "./inline-links";
import type { GoatBrainDocument, GoatBrainFrontmatter, GoatBrainTimelineEntry } from "./schema";
import { deterministicEvidenceId, normalizeEvidenceId, normalizeTimelineAt } from "./timeline";

export const GOAT_BRAIN_TRUTH_HEADING = "## Compiled truth";
export const GOAT_BRAIN_TIMELINE_HEADING = "## Timeline";
export const GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER = "_No compiled truth yet._";
export const GOAT_BRAIN_TIMELINE_SENTINEL =
  "<!-- TIMELINE:BELOW - append only past this marker -->";

// File-backed documents materialize with a generated
// "extracted text" block appended after the timeline. The block is derived
// from the DB row on every materialization and is never authoritative: the
// parser strips it, so edits inside it are discarded on sync.
export const GOAT_BRAIN_ASSET_TEXT_BEGIN =
  "<!-- ASSET-TEXT:BEGIN generated from the source file; edits below are discarded -->";
export const GOAT_BRAIN_ASSET_TEXT_END = "<!-- ASSET-TEXT:END -->";
export const GOAT_BRAIN_ASSET_TEXT_HEADING = "## Extracted text";

export function stripGoatBrainAssetTextBlock(source: string): string {
  let result = source;
  while (true) {
    const begin = result.indexOf(GOAT_BRAIN_ASSET_TEXT_BEGIN);
    if (begin === -1) break;
    const end = result.indexOf(GOAT_BRAIN_ASSET_TEXT_END, begin);
    let sliceEnd = end === -1 ? result.length : end + GOAT_BRAIN_ASSET_TEXT_END.length;
    if (result[sliceEnd] === "\n") sliceEnd += 1;
    result = result.slice(0, begin) + result.slice(sliceEnd);
  }
  return result;
}

export function extractGoatBrainAssetText(source: string): string {
  const begin = source.indexOf(GOAT_BRAIN_ASSET_TEXT_BEGIN);
  if (begin === -1) return "";
  const contentStart = begin + GOAT_BRAIN_ASSET_TEXT_BEGIN.length;
  const end = source.indexOf(GOAT_BRAIN_ASSET_TEXT_END, contentStart);
  const raw = source.slice(contentStart, end === -1 ? source.length : end);
  return raw.replace(GOAT_BRAIN_ASSET_TEXT_HEADING, "").trim();
}

export function appendGoatBrainAssetTextBlock(content: string, assetText: string): string {
  const text = assetText.trim();
  if (!text) return content;
  const separator = content.endsWith("\n") ? "" : "\n";
  // Purely additive so stripGoatBrainAssetTextBlock restores the input
  // byte-for-byte — sync relies on that to keep content hashes stable.
  return `${content}${separator}${[
    GOAT_BRAIN_ASSET_TEXT_BEGIN,
    "",
    GOAT_BRAIN_ASSET_TEXT_HEADING,
    "",
    text,
    "",
    GOAT_BRAIN_ASSET_TEXT_END,
    "",
  ].join("\n")}`;
}

export type ParsedGoatBrainDocument = {
  frontmatter: Partial<GoatBrainFrontmatter>;
  title: string;
  compiledTruth: string;
  timeline: GoatBrainTimelineEntry[];
};

export function parseGoatBrainDocument(source: string): ParsedGoatBrainDocument {
  const { yaml, body } = splitFrontmatter(stripGoatBrainAssetTextBlock(source));
  const frontmatter = parseFrontmatter(yaml);
  const parsedBody = parseGoatBrainBody(body);
  return { frontmatter, ...parsedBody };
}

export function normalizeGoatBrainBody(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!looksLikeLegacyGoatBrainDocument(normalized)) return value;
  const parsed = parseGoatBrainDocument(normalized);
  if (!isNestedLegacyGoatBrainDocument(parsed)) return value;
  return parsed.compiledTruth;
}

export function normalizeGoatBrainCompiledTruth(value: string, title?: string): string {
  const body = normalizeGoatBrainBody(value);
  const trimmed = body.replace(/\r\n/g, "\n").trim();
  const normalizedTitle = comparableTitle(title ?? "");
  if (!normalizedTitle) return trimmed;

  const firstHeading = /^(#{1,6})[ \t]+(.+?)[ \t]*(?:\n|$)/.exec(trimmed);
  if (!firstHeading?.[2]) return trimmed;
  const headingText = firstHeading[2].replace(/[ \t]+#+[ \t]*$/, "");
  if (comparableTitle(headingText) !== normalizedTitle) return trimmed;
  return trimmed.slice(firstHeading[0].length).replace(/^\n+/, "");
}

export function parseGoatBrainBody(body: string): {
  title: string;
  compiledTruth: string;
  timeline: GoatBrainTimelineEntry[];
} {
  const normalized = body.replace(/\r\n/g, "\n");
  const title = readTitle(normalized);
  const truthStart = sectionStart(normalized, GOAT_BRAIN_TRUTH_HEADING);
  const lastSentinelStart = normalized.lastIndexOf(GOAT_BRAIN_TIMELINE_SENTINEL);
  const sentinelStart =
    truthStart !== -1 && lastSentinelStart > truthStart ? lastSentinelStart : -1;
  const timelineStart =
    sentinelStart !== -1
      ? sectionStartFrom(normalized, GOAT_BRAIN_TIMELINE_HEADING, sentinelStart)
      : sectionStart(normalized, GOAT_BRAIN_TIMELINE_HEADING);
  let compiledTruth = "";
  if (truthStart !== -1) {
    const truthEnd =
      sentinelStart !== -1
        ? sentinelStart
        : timelineStart !== -1 && timelineStart > truthStart
          ? timelineStart
          : normalized.length;
    compiledTruth = stripSentinel(
      normalized.slice(truthStart + GOAT_BRAIN_TRUTH_HEADING.length, truthEnd),
    ).trim();
  }
  const timeline =
    timelineStart !== -1
      ? parseTimeline(normalized.slice(timelineStart + GOAT_BRAIN_TIMELINE_HEADING.length))
      : [];
  return { title, compiledTruth, timeline };
}

export function serializeGoatBrainDocument(doc: GoatBrainDocument): string {
  const title = doc.title.trim() || doc.frontmatter.title?.trim() || doc.frontmatter.id;
  const compiledTruth = normalizeGoatBrainCompiledTruth(doc.compiledTruth, title);
  const timeline = [...doc.timeline].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const timelineBody = timeline
    .map((entry) => {
      const evidenceId =
        normalizeEvidenceId(entry.evidenceId) ??
        deterministicEvidenceId({ at: entry.at, summary: entry.body });
      return `### ${evidenceId} - ${entry.at}\n${entry.body.trim()}`;
    })
    .join("\n\n");
  return [
    serializeFrontmatter({
      ...doc.frontmatter,
      title,
    }),
    "",
    `# ${title}`,
    "",
    GOAT_BRAIN_TRUTH_HEADING,
    compiledTruth.trim() || GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER,
    "",
    GOAT_BRAIN_TIMELINE_SENTINEL,
    "",
    GOAT_BRAIN_TIMELINE_HEADING,
    timelineBody,
    "",
  ].join("\n");
}

export function replaceGoatBrainCompiledTruth(
  source: string,
  compiledTruth: string,
  options: { updatedAt?: string } = {},
): string {
  const { yaml, body } = splitFrontmatter(source);
  const frontmatter = parseFrontmatter(yaml);
  const title = frontmatter.title ?? readTitle(body) ?? "Untitled";
  const normalizedCompiledTruth = normalizeGoatBrainCompiledTruth(compiledTruth, title);
  const header =
    frontmatter.id &&
    frontmatter.folder &&
    frontmatter.kind &&
    frontmatter.type &&
    frontmatter.status &&
    frontmatter.createdAt &&
    frontmatter.updatedAt
      ? `${serializeFrontmatter({
          id: frontmatter.id,
          folder: frontmatter.folder,
          kind: frontmatter.kind,
          type: frontmatter.type,
          status: frontmatter.status,
          createdAt: frontmatter.createdAt,
          updatedAt: options.updatedAt ?? frontmatter.updatedAt,
          relations: frontmatter.relations ?? [],
          ...(frontmatter.title ? { title: frontmatter.title } : {}),
          ...(frontmatter.description ? { description: frontmatter.description } : {}),
          ...(frontmatter.aliases ? { aliases: frontmatter.aliases } : {}),
          ...(frontmatter.sources ? { sources: frontmatter.sources } : {}),
          ...(frontmatter.mergedInto ? { mergedInto: frontmatter.mergedInto } : {}),
        })}\n\n`
      : yaml
        ? `---\n${yaml.trim()}\n---\n\n`
        : "";
  return `${header}${replaceCompiledTruthInBody(body, normalizedCompiledTruth)}`;
}

function looksLikeLegacyGoatBrainDocument(value: string): boolean {
  return (
    value.startsWith("---\n") &&
    value.includes("\n---") &&
    value.includes(GOAT_BRAIN_TRUTH_HEADING) &&
    value.includes(GOAT_BRAIN_TIMELINE_HEADING)
  );
}

function isNestedLegacyGoatBrainDocument(parsed: ParsedGoatBrainDocument): boolean {
  return Boolean(
    parsed.frontmatter.id &&
      parsed.frontmatter.folder &&
      parsed.frontmatter.kind &&
      parsed.frontmatter.type &&
      parsed.compiledTruth.trim(),
  );
}

function readTitle(body: string): string {
  for (const line of body.split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1];
    if (line.startsWith("## ")) break;
  }
  return "";
}

function sectionStart(body: string, heading: string): number {
  const re = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m");
  const match = re.exec(body);
  return match ? match.index : -1;
}

function sectionStartFrom(body: string, heading: string, start: number): number {
  const offset = Math.max(0, start);
  const index = sectionStart(body.slice(offset), heading);
  return index === -1 ? -1 : offset + index;
}

function replaceCompiledTruthInBody(body: string, compiledTruth: string): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const truthStart = sectionStart(normalized, GOAT_BRAIN_TRUTH_HEADING);
  if (truthStart === -1) {
    const title = readTitle(normalized) || "Untitled";
    const timelineStart = sectionStart(normalized, GOAT_BRAIN_TIMELINE_HEADING);
    const timelineTail =
      timelineStart !== -1
        ? normalized.slice(timelineStart).trimEnd()
        : GOAT_BRAIN_TIMELINE_HEADING;
    return [
      `# ${title}`,
      "",
      GOAT_BRAIN_TRUTH_HEADING,
      compiledTruth.trim() || GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER,
      "",
      GOAT_BRAIN_TIMELINE_SENTINEL,
      "",
      timelineTail,
    ].join("\n");
  }

  const truthHeadingEnd = normalized.indexOf("\n", truthStart);
  const contentStart =
    truthHeadingEnd === -1 ? truthStart + GOAT_BRAIN_TRUTH_HEADING.length : truthHeadingEnd + 1;
  const timelineStart = sectionStart(normalized, GOAT_BRAIN_TIMELINE_HEADING);
  const sentinelStart = normalized.indexOf(GOAT_BRAIN_TIMELINE_SENTINEL, contentStart);
  const contentEnd =
    sentinelStart !== -1 && (timelineStart === -1 || sentinelStart < timelineStart)
      ? sentinelStart
      : timelineStart !== -1
        ? timelineStart
        : normalized.length;
  const prefix = normalized.slice(0, contentStart).replace(/\n*$/, "\n");
  const suffix = normalized.slice(contentEnd).replace(/^\n*/, "");
  return `${prefix}${compiledTruth.trim() || GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER}\n\n${suffix}`;
}

function stripSentinel(text: string): string {
  return text
    .replace(GOAT_BRAIN_TIMELINE_SENTINEL, "")
    .replace(/<!--\s*TIMELINE:BELOW[\s\S]*?-->/g, "");
}

function comparableTitle(value: string): string {
  return value
    .trim()
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function parseTimeline(text: string): GoatBrainTimelineEntry[] {
  const entries: GoatBrainTimelineEntry[] = [];
  const re = /^###\s+(.+?)\s*$/gm;
  const matches = [...text.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    if (!current || current.index === undefined) continue;
    const heading = (current[1] ?? "").trim();
    const bodyStart = current.index + current[0].length;
    const next = matches[i + 1];
    const bodyEnd = next?.index ?? text.length;
    const entryBody = text.slice(bodyStart, bodyEnd).trim();
    const parsed = parseTimelineHeading(heading, entryBody);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

const TIMELINE_EVIDENCE_HEADING = /^(ev-[a-z0-9][a-z0-9-]{0,76})\s+-\s+(.+)$/;

function parseTimelineHeading(heading: string, body: string): GoatBrainTimelineEntry | null {
  const evidenceHeading = TIMELINE_EVIDENCE_HEADING.exec(heading);
  if (evidenceHeading?.[1] && evidenceHeading[2]) {
    const at = normalizeTimelineAt(evidenceHeading[2]);
    if (!at) return null;
    return { evidenceId: evidenceHeading[1], at, body };
  }
  const at = normalizeTimelineAt(heading);
  if (!at) return null;
  return {
    evidenceId: deterministicEvidenceId({ at, summary: body }),
    at,
    body,
  };
}

export function extractGoatBrainCitations(text: string): string[] {
  const ids = new Set<string>();
  for (const link of parseGoatBrainInlineLinks(text)) {
    if (link.kind !== "evidence") continue;
    const id = normalizeEvidenceId(link.target);
    if (id && link.valid) ids.add(id);
  }
  return [...ids];
}

export const extractCitations = extractGoatBrainCitations;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
