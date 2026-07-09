import {
  isValidGoatBrainEvidenceId,
  isValidGoatBrainId,
  isValidGoatBrainSourceRef,
} from "./schema";

const BRACKET_LINK_PATTERN = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;
const LEGACY_EVIDENCE_CITATION_PATTERN = /(?<!\\)\[\^ev:([^\]\n]+)\]/g;

export type GoatBrainInlineLinkKind = "page" | "evidence" | "source";

export type GoatBrainInlineLink = {
  raw: string;
  kind: GoatBrainInlineLinkKind;
  target: string;
  label: string;
  index: number;
  valid: boolean;
  legacy: boolean;
};

export function parseGoatBrainInlineLinks(text: string): GoatBrainInlineLink[] {
  const links: GoatBrainInlineLink[] = [];

  for (const match of text.matchAll(BRACKET_LINK_PATTERN)) {
    const rawTarget = (match[1] ?? "").trim();
    const parsed = parseBracketTarget(rawTarget);
    const label = (match[2] ?? parsed.target).trim();
    links.push({
      raw: match[0],
      kind: parsed.kind,
      target: parsed.target,
      label,
      index: match.index ?? 0,
      valid: isValidInlineLinkTarget(parsed.kind, parsed.target),
      legacy: parsed.legacy,
    });
  }

  for (const match of text.matchAll(LEGACY_EVIDENCE_CITATION_PATTERN)) {
    const target = (match[1] ?? "").trim();
    links.push({
      raw: match[0],
      kind: "evidence",
      target,
      label: target,
      index: match.index ?? 0,
      valid: isValidInlineLinkTarget("evidence", target),
      legacy: true,
    });
  }

  return links.sort((a, b) => a.index - b.index || a.raw.localeCompare(b.raw));
}

export function formatGoatBrainPageLink(id: string, label?: string): string {
  return formatBracketLink("page", id, label);
}

export function formatGoatBrainEvidenceLink(id: string, label?: string): string {
  return formatBracketLink("evidence", id, label);
}

export function formatGoatBrainSourceLink(ref: string, label?: string): string {
  return formatBracketLink("source", ref, label);
}

export function pageLinkTargets(text: string): string[] {
  return inlineLinkTargets(text, "page");
}

export function evidenceLinkTargets(text: string): string[] {
  return inlineLinkTargets(text, "evidence");
}

export function sourceLinkTargets(text: string): string[] {
  return inlineLinkTargets(text, "source");
}

export function isValidGoatBrainInlineLinkTarget(
  kind: GoatBrainInlineLinkKind,
  target: string,
): boolean {
  return isValidInlineLinkTarget(kind, target);
}

function parseBracketTarget(value: string): {
  kind: GoatBrainInlineLinkKind;
  target: string;
  legacy: boolean;
} {
  const separator = value.indexOf(":");
  if (separator === -1) return { kind: "page", target: value, legacy: true };

  const prefix = value.slice(0, separator);
  const target = value.slice(separator + 1).trim();
  if (prefix === "page" || prefix === "evidence" || prefix === "source") {
    return { kind: prefix, target, legacy: false };
  }
  return { kind: "page", target: value, legacy: true };
}

function formatBracketLink(
  kind: GoatBrainInlineLinkKind,
  target: string,
  label: string | undefined,
): string {
  const normalizedTarget = target.trim();
  if (!isValidInlineLinkTarget(kind, normalizedTarget)) {
    throw new Error(`Invalid Goat Brain ${kind} link target.`);
  }
  const normalizedLabel = label?.trim();
  if (normalizedLabel && !isValidInlineLinkLabel(normalizedLabel)) {
    throw new Error("Invalid Goat Brain link label.");
  }
  return normalizedLabel
    ? `[[${kind}:${normalizedTarget}|${normalizedLabel}]]`
    : `[[${kind}:${normalizedTarget}]]`;
}

function inlineLinkTargets(text: string, kind: GoatBrainInlineLinkKind): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const link of parseGoatBrainInlineLinks(text)) {
    if (link.kind !== kind || !link.valid || seen.has(link.target)) continue;
    seen.add(link.target);
    targets.push(link.target);
  }
  return targets;
}

function isValidInlineLinkTarget(kind: GoatBrainInlineLinkKind, target: string): boolean {
  switch (kind) {
    case "page":
      return isValidGoatBrainId(target);
    case "evidence":
      return isValidGoatBrainEvidenceId(target);
    case "source":
      return isValidGoatBrainSourceRef(target);
  }
}

function isValidInlineLinkLabel(label: string): boolean {
  return label.trim().length > 0 && !/[\]\n]/.test(label);
}
