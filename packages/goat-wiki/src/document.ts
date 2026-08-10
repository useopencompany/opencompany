// Wiki page file format: markdown with a minimal frontmatter block.
//
//   ---
//   kind: project
//   ---
//   # Website redesign
//   ...
//
// `kind` is the only frontmatter field. Everything else about a page is either
// in the body (links, sources — parsed from inline `[[...]]`), in the DB
// (timeline, versions), or derived (title from the first H1). Unknown
// frontmatter keys parse without error and are dropped on rewrite, so agents
// can never grow the surface by inventing fields.

import { parse as parseYaml } from "yaml";
import { DEFAULT_WIKI_KIND, isValidWikiKind, type WikiKind } from "./schema";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type ParsedWikiPageFile = {
  kind: WikiKind;
  body: string;
};

export function parseWikiPageFile(fileText: string): ParsedWikiPageFile {
  const match = FRONTMATTER_PATTERN.exec(fileText);
  if (!match) return { kind: DEFAULT_WIKI_KIND, body: fileText };

  // The single separating blank line serialize emits is formatting, not body.
  const body = fileText.slice(match[0].length).replace(/^\r?\n/, "");
  let kind: WikiKind = DEFAULT_WIKI_KIND;
  try {
    const frontmatter: unknown = parseYaml(match[1] ?? "");
    if (frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter)) {
      const rawKind = (frontmatter as Record<string, unknown>).kind;
      if (isValidWikiKind(rawKind)) kind = rawKind;
    }
  } catch {
    // Malformed YAML degrades to the default kind rather than failing the read;
    // the body is still the page.
  }
  return { kind, body };
}

export function serializeWikiPageFile(page: { kind: WikiKind; body: string }): string {
  const body = page.body.replace(/^\r?\n+/, "");
  return `---\nkind: ${page.kind}\n---\n\n${body}`;
}

/**
 * A page's title is its first markdown H1; `fallback` (usually the slug) covers
 * pages without one. Titles are display-only and never part of identity.
 */
export function deriveWikiTitle(body: string, fallback: string): string {
  for (const line of body.split("\n")) {
    const match = /^#[ \t]+(.+?)[ \t]*$/.exec(line.trim());
    if (match?.[1]) return match[1].replace(/[ \t]*#+$/, "").trim() || fallback;
  }
  return fallback;
}
