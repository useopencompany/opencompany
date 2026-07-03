import { parseFrontmatter, serializeFrontmatter, splitFrontmatter } from "./frontmatter";
import type { GoatBrainDocument, GoatBrainFrontmatter, GoatBrainTimelineEntry } from "./schema";

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
    .map((entry) => `### ${entry.at}\n${entry.body.trim()}`)
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
    const at = (current[1] ?? "").trim();
    const bodyStart = current.index + current[0].length;
    const next = matches[i + 1];
    const bodyEnd = next?.index ?? text.length;
    const entryBody = text.slice(bodyStart, bodyEnd).trim();
    if (at) entries.push({ at, body: entryBody });
  }
  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
