import {
  isValidGoatBrainEvidenceId,
  isValidGoatBrainId,
  isValidGoatBrainSourceRef,
} from "./schema";

const BRACKET_LINK_PATTERN = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;
const LEGACY_EVIDENCE_CITATION_PATTERN = /\[\^ev:([^\]\n]+)\]/g;

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
  const ignoredRanges = markdownCodeRanges(text);

  for (const match of text.matchAll(BRACKET_LINK_PATTERN)) {
    const index = match.index ?? 0;
    if (isEscaped(text, index) || rangeContainsIndex(ignoredRanges, index)) continue;
    const rawTarget = (match[1] ?? "").trim();
    const parsed = parseBracketTarget(rawTarget);
    const label = (match[2] ?? parsed.target).trim();
    links.push({
      raw: match[0],
      kind: parsed.kind,
      target: parsed.target,
      label,
      index,
      valid: isValidInlineLinkTarget(parsed.kind, parsed.target),
      legacy: parsed.legacy,
    });
  }

  for (const match of text.matchAll(LEGACY_EVIDENCE_CITATION_PATTERN)) {
    const index = match.index ?? 0;
    if (isEscaped(text, index) || rangeContainsIndex(ignoredRanges, index)) continue;
    const target = (match[1] ?? "").trim();
    links.push({
      raw: match[0],
      kind: "evidence",
      target,
      label: target,
      index,
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
  return label.trim().length > 0 && !/[\[\]\n]/.test(label);
}

type TextRange = { start: number; end: number };

function markdownCodeRanges(text: string): TextRange[] {
  const fencedRanges: TextRange[] = [];
  let openFence: { start: number; marker: "`" | "~"; length: number } | null = null;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const nextLineStart = newline === -1 ? text.length : newline + 1;
    const line = text.slice(lineStart, lineEnd);

    if (openFence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line)?.[1];
      if (closing?.[0] === openFence.marker && closing.length >= openFence.length) {
        fencedRanges.push({ start: openFence.start, end: nextLineStart });
        openFence = null;
      }
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const markerRun = opening?.[1];
      if (markerRun && !(markerRun[0] === "`" && opening?.[2]?.includes("`"))) {
        openFence = {
          start: lineStart,
          marker: markerRun[0] as "`" | "~",
          length: markerRun.length,
        };
      } else if (/^(?: {4}|\t)/.test(line)) {
        fencedRanges.push({ start: lineStart, end: nextLineStart });
      }
    }

    if (newline === -1) break;
    lineStart = nextLineStart;
  }

  if (openFence) fencedRanges.push({ start: openFence.start, end: text.length });

  const ranges = [...fencedRanges];
  let cursor = 0;
  while (cursor < text.length) {
    const fenced = rangeAtOrAfter(fencedRanges, cursor);
    if (fenced?.start === cursor || (fenced && cursor > fenced.start && cursor < fenced.end)) {
      cursor = fenced.end;
      continue;
    }
    if (fenced && cursor < fenced.start && text[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    if (text[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    if (isEscaped(text, cursor)) {
      cursor += 1;
      continue;
    }

    const openingStart = cursor;
    while (text[cursor] === "`") cursor += 1;
    const length = cursor - openingStart;
    const closingStart = matchingBacktickRun(text, cursor, length, fencedRanges);
    if (closingStart === -1) continue;
    const end = closingStart + length;
    ranges.push({ start: openingStart, end });
    cursor = end;
  }

  return ranges.sort((a, b) => a.start - b.start);
}

function matchingBacktickRun(
  text: string,
  from: number,
  length: number,
  fencedRanges: TextRange[],
): number {
  let cursor = from;
  while (cursor < text.length) {
    const fenced = rangeAtOrAfter(fencedRanges, cursor);
    if (fenced && cursor >= fenced.start && cursor < fenced.end) {
      cursor = fenced.end;
      continue;
    }
    const candidate = text.indexOf("`", cursor);
    if (candidate === -1 || (fenced && candidate >= fenced.start)) return -1;
    if (isEscaped(text, candidate)) {
      cursor = candidate + 1;
      continue;
    }
    let end = candidate;
    while (text[end] === "`") end += 1;
    if (end - candidate === length) return candidate;
    cursor = end;
  }
  return -1;
}

function rangeAtOrAfter(ranges: TextRange[], index: number): TextRange | undefined {
  return ranges.find((range) => range.end > index);
}

function rangeContainsIndex(ranges: TextRange[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}
