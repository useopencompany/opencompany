import { parseFrontmatter, serializeFrontmatter, splitFrontmatter } from "./frontmatter";
import type { MemoryDocument, MemoryFrontmatter, TimelineEntry } from "./schema";

// The two-layer body convention. These literals are the contract the parser and serializer
// share; doctor's body-shape check keys off the same markers.
export const TRUTH_HEADING = "## Compiled truth";
export const TIMELINE_HEADING = "## Timeline";
export const TIMELINE_SENTINEL = "<!-- TIMELINE:BELOW — append only past this marker -->";

export type ParsedDocument = {
  frontmatter: Partial<MemoryFrontmatter>;
  title: string;
  compiledTruth: string;
  timeline: TimelineEntry[];
};

// Lenient parse of a full memory file (frontmatter + two-layer body). Never throws; strict
// validation is layered on top in validate.ts.
export function parseDocument(source: string): ParsedDocument {
  const { yaml, body } = splitFrontmatter(source);
  const frontmatter = parseFrontmatter(yaml);
  const { title, compiledTruth, timeline } = parseBody(body);
  return { frontmatter, title, compiledTruth, timeline };
}

export function parseBody(body: string): {
  title: string;
  compiledTruth: string;
  timeline: TimelineEntry[];
} {
  const normalized = body.replace(/\r\n/g, "\n");
  const title = readTitle(normalized);

  const truthStart = sectionStart(normalized, TRUTH_HEADING);
  const timelineStart = sectionStart(normalized, TIMELINE_HEADING);

  let compiledTruth = "";
  if (truthStart !== -1) {
    const truthEnd =
      timelineStart !== -1 && timelineStart > truthStart ? timelineStart : normalized.length;
    compiledTruth = stripSentinel(
      normalized.slice(truthStart + TRUTH_HEADING.length, truthEnd),
    ).trim();
  }

  const timeline =
    timelineStart !== -1
      ? parseTimeline(normalized.slice(timelineStart + TIMELINE_HEADING.length))
      : [];

  return { title, compiledTruth, timeline };
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

function stripSentinel(text: string): string {
  return text.replace(TIMELINE_SENTINEL, "").replace(/<!--\s*TIMELINE:BELOW[\s\S]*?-->/g, "");
}

// Parse `### <iso>` blocks. Entries keep insertion order; the serializer enforces newest-first.
function parseTimeline(text: string): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const re = /^###\s+(.+?)\s*$/gm;
  const matches = [...text.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    if (!current || current.index === undefined) continue;
    const at = (current[1] ?? "").trim();
    const bodyStart = current.index + current[0].length;
    const next = matches[i + 1];
    const bodyEnd = next?.index ?? text.length;
    const entryBody = text.slice(bodyStart, bodyEnd).trim();
    if (at) entries.push({ at, body: entryBody });
  }
  return entries;
}

// Serialize a fully-formed document back to the canonical on-disk shape. Timeline is sorted
// newest-first so the most recent evidence reads at the top of the section.
export function serializeDocument(doc: MemoryDocument): string {
  const title = doc.title.trim() || doc.frontmatter.id;
  const timeline = [...doc.timeline].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const timelineBody = timeline
    .map((entry) => `### ${entry.at}\n${entry.body.trim()}`)
    .join("\n\n");

  return [
    serializeFrontmatter(doc.frontmatter),
    "",
    `# ${title}`,
    "",
    TRUTH_HEADING,
    doc.compiledTruth.trim() || "_No compiled truth yet._",
    "",
    TIMELINE_SENTINEL,
    "",
    TIMELINE_HEADING,
    timelineBody,
    "",
  ].join("\n");
}

// Footnote citations to evidence, e.g. `[^ev:acme-call-2026-06-06]`. Extracted so rewrite can
// enforce the "compiled truth must cite linked evidence" invariant and doctor can find broken
// citations.
const CITATION_RE = /\[\^ev:([a-z0-9][a-z0-9-]{0,63})\]/g;

export function extractCitations(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(CITATION_RE)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
