import GithubSlugger from "github-slugger";

export type TableOfContentsItem = {
  id: string;
  text: string;
  level: 2 | 3;
};

export function extractTableOfContents(markdown: string): TableOfContentsItem[] {
  const slugger = new GithubSlugger();
  const headings: TableOfContentsItem[] = [];
  let inCodeBlock = false;

  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) continue;

    const match = /^(#{2,3})\s+(.+)$/.exec(line);
    if (!match) continue;

    const [, markers, rawText] = match;
    if (!markers || !rawText) continue;

    const text = rawText
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();

    headings.push({
      id: slugger.slug(text),
      text,
      level: markers.length as 2 | 3,
    });
  }

  return headings;
}
