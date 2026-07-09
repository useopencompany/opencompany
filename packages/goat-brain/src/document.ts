import { parseFrontmatter, serializeFrontmatter, splitFrontmatter } from "./frontmatter";
import { parseGoatBrainInlineLinks } from "./inline-links";
import type { GoatBrainDocument, GoatBrainFrontmatter, GoatBrainTimelineEntry } from "./schema";
import { deterministicEvidenceId, normalizeEvidenceId, normalizeTimelineAt } from "./timeline";

export const GOAT_BRAIN_TRUTH_HEADING = "## Compiled truth";
export const GOAT_BRAIN_TIMELINE_HEADING = "## Timeline";
export const GOAT_BRAIN_TIMELINE_SENTINEL =
  "<!-- TIMELINE:BELOW - append only past this marker -->";

export type ParsedGoatBrainDocument = {
  frontmatter: Partial<GoatBrainFrontmatter>;
  title: string;
  compiledTruth: string;
  timeline: GoatBrainTimelineEntry[];
};

export function parseGoatBrainDocument(source: string): ParsedGoatBrainDocument {
  const { yaml, body } = splitFrontmatter(source);
  const frontmatter = parseFrontmatter(yaml);
  const parsedBody = parseGoatBrainBody(body);
  return { frontmatter, ...parsedBody };
}

export function parseGoatBrainBody(body: string): {
  title: string;
  compiledTruth: string;
  timeline: GoatBrainTimelineEntry[];
} {
  const normalized = body.replace(/\r\n/g, "\n");
  const title = readTitle(normalized);
  const truthStart = sectionStart(normalized, GOAT_BRAIN_TRUTH_HEADING);
  const timelineStart = sectionStart(normalized, GOAT_BRAIN_TIMELINE_HEADING);
  let compiledTruth = "";
  if (truthStart !== -1) {
    const truthEnd =
      timelineStart !== -1 && timelineStart > truthStart ? timelineStart : normalized.length;
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
    doc.compiledTruth.trim() || "_No compiled truth yet._",
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
          ...(frontmatter.aliases ? { aliases: frontmatter.aliases } : {}),
          ...(frontmatter.sources ? { sources: frontmatter.sources } : {}),
          ...(frontmatter.mergedInto ? { mergedInto: frontmatter.mergedInto } : {}),
        })}\n\n`
      : yaml
        ? `---\n${yaml.trim()}\n---\n\n`
        : "";
  return `${header}${replaceCompiledTruthInBody(body, compiledTruth)}`;
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
      compiledTruth.trim() || "_No compiled truth yet._",
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
  return `${prefix}${compiledTruth.trim() || "_No compiled truth yet._"}\n\n${suffix}`;
}

function stripSentinel(text: string): string {
  return text
    .replace(GOAT_BRAIN_TIMELINE_SENTINEL, "")
    .replace(/<!--\s*TIMELINE:BELOW[\s\S]*?-->/g, "");
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
