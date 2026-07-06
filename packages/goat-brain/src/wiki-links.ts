import { isValidGoatBrainId } from "./schema";

const WIKI_LINK_PATTERN = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;

export type GoatBrainWikiLink = {
  raw: string;
  target: string;
  label: string;
  index: number;
  valid: boolean;
};

export function parseGoatBrainWikiLinks(text: string): GoatBrainWikiLink[] {
  return [...text.matchAll(WIKI_LINK_PATTERN)].map((match) => {
    const target = (match[1] ?? "").trim();
    const label = (match[2] ?? target).trim();
    return {
      raw: match[0],
      target,
      label,
      index: match.index ?? 0,
      valid: isValidGoatBrainId(target),
    };
  });
}

export function wikiLinkTargets(text: string): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const link of parseGoatBrainWikiLinks(text)) {
    if (!link.valid || seen.has(link.target)) continue;
    seen.add(link.target);
    targets.push(link.target);
  }
  return targets;
}
