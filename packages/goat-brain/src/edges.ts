import { evidenceLinkTargets, pageLinkTargets } from "./inline-links";
import {
  DEFAULT_GOAT_BRAIN_RELATION_TYPE,
  type GoatBrainDerivedEdge,
  type GoatBrainRelation,
  isValidGoatBrainId,
  isValidGoatBrainRelationType,
} from "./schema";

export function deriveGoatBrainEdges(input: {
  id: string;
  relations?: GoatBrainRelation[];
  body?: string;
}): GoatBrainDerivedEdge[] {
  if (!isValidGoatBrainId(input.id)) return [];
  const byKey = new Map<string, GoatBrainDerivedEdge>();
  const add = (edge: GoatBrainDerivedEdge) => {
    if (edge.from === edge.to) return;
    byKey.set(`${edge.sourceKind}:${edge.type}:${edge.from}:${edge.to}`, edge);
  };

  for (const relation of input.relations ?? []) {
    const type = relation.type || DEFAULT_GOAT_BRAIN_RELATION_TYPE;
    if (!isValidGoatBrainRelationType(type) || !isValidGoatBrainId(relation.to)) continue;
    add({
      from: input.id,
      to: relation.to,
      type,
      sourceKind: "relation",
    });
  }

  for (const target of pageLinkTargets(input.body ?? "")) {
    add({
      from: input.id,
      to: target,
      type: "wiki_link",
      sourceKind: "wiki_link",
    });
  }

  for (const target of evidenceLinkTargets(input.body ?? "")) {
    add({
      from: input.id,
      to: target,
      type: "cites",
      sourceKind: "wiki_link",
    });
  }

  return [...byKey.values()].sort((a, b) =>
    `${a.from}:${a.to}:${a.type}:${a.sourceKind}`.localeCompare(
      `${b.from}:${b.to}:${b.type}:${b.sourceKind}`,
    ),
  );
}
