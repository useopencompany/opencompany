import { pageLinkTargets, parseGoatBrainInlineLinks } from "./inline-links";

export type GoatBrainWikiLink = {
  raw: string;
  target: string;
  label: string;
  index: number;
  valid: boolean;
};

export function parseGoatBrainWikiLinks(text: string): GoatBrainWikiLink[] {
  return parseGoatBrainInlineLinks(text)
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
