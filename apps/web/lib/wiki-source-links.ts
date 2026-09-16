// Rendering side of a source pointer: `[[source:provider:id]]` -> a chip with a
// label and, where the provider has a canonical URL, a link.
//
// Provider grammar, labels, and URLs live in one place — the registry in
// `@opencompany/wiki/sources`, which also generates the ref shapes the wiki tool
// prompts agents with. This module only adds the app-specific href checks.

import { parseWikiSourceRef } from "@opencompany/wiki";
import { describeWikiSourceRef, safeExternalUrl } from "@opencompany/wiki/sources";

export function sourceHrefForRef(ref: string): string | null {
  if (!parseWikiSourceRef(ref)) return null;
  return describeWikiSourceRef(ref)?.href ?? null;
}

export function isExternalHref(href: string): boolean {
  return Boolean(safeExternalUrl(href));
}

export type WikiSourceChip = { icon: "github" | "link"; label: string };

/**
 * Compact display for an inline source chip. An author-written label always
 * wins — it is the only part of a pointer a human chose. Otherwise the chip
 * falls back to the registry's name for the artifact ("ENG-123", "#123",
 * "Gmail thread") instead of showing the raw ref, and a ref the registry cannot
 * place keeps the raw ref so nothing is silently hidden.
 */
export function sourceChipDisplay(ref: string, fallbackLabel: string): WikiSourceChip {
  const described = describeWikiSourceRef(ref);
  if (!described) return { icon: "link", label: fallbackLabel };
  const authored = fallbackLabel !== ref ? fallbackLabel : "";
  return { icon: described.icon, label: authored || described.label };
}
