import type { QuickActionItem } from "./quick-action-catalog";

const WORD_SEPARATOR = /[\s/_.-]+/;

/**
 * Keeps items whose label has a word starting with the query, or whose id or slug starts with it.
 * Label-prefix matches come first; otherwise the catalog order holds. So `s` finds Sketch and
 * Search but not Deep research.
 */
export const filterQuickActions = (
  items: readonly QuickActionItem[],
  query: string,
): QuickActionItem[] => {
  const search = query.toLowerCase();
  if (!search) return [...items];
  return items
    .flatMap((item, index) => {
      const label = item.label.toLowerCase();
      const labelPrefix = label.startsWith(search);
      const matches =
        labelPrefix ||
        label.split(WORD_SEPARATOR).some((word) => word.startsWith(search)) ||
        item.aliases.some((alias) => alias.toLowerCase().startsWith(search));
      return matches ? [{ item, rank: labelPrefix ? 0 : 1, index }] : [];
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => item);
};
