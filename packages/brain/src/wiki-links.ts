import { pageLinkTargets, parseBrainInlineLinks } from "./inline-links";

export type BrainWikiLink = {
  raw: string;
  target: string;
  label: string;
  index: number;
  valid: boolean;
};

export function parseBrainWikiLinks(text: string): BrainWikiLink[] {
  return parseBrainInlineLinks(text)
    .filter((link) => link.kind === "page")
    .map((link) => ({
      raw: link.raw,
      target: link.target,
      label: link.label,
      index: link.index,
      valid: link.valid,
    }));
}

export function wikiLinkTargets(text: string): string[] {
  return pageLinkTargets(text);
}
