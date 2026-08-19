import { rewriteWikiPageLinks } from "@opencompany/wiki";

export type WikiBackfillPageIdentity = {
  path: string;
  slug: string;
  nodeType: "page" | "folder";
};

export function canonicalWikiPathBySlug(nodes: WikiBackfillPageIdentity[]): Map<string, string> {
  const pathsBySlug = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.nodeType !== "page") continue;
    const paths = pathsBySlug.get(node.slug);
    if (paths) paths.push(node.path);
    else pathsBySlug.set(node.slug, [node.path]);
  }
  return new Map(
    [...pathsBySlug].flatMap(([slug, paths]) =>
      paths.length === 1 && paths[0] ? [[slug, paths[0]] as const] : [],
    ),
  );
}

export function canonicalizeWikiPageLinks(text: string, nodes: WikiBackfillPageIdentity[]): string {
  const pagePaths = new Set(
    nodes.filter((node) => node.nodeType === "page").map((node) => node.path),
  );
  const pathBySlug = canonicalWikiPathBySlug(nodes);
  return rewriteWikiPageLinks(text, (target) => {
    if (pagePaths.has(target) || target.includes("/")) return null;
    return pathBySlug.get(target) ?? null;
  });
}
