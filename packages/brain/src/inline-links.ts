import { isValidBrainEvidenceId, isValidBrainId, isValidBrainSourceRef } from "./schema";

const BRACKET_LINK_PATTERN = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g;
const LEGACY_EVIDENCE_CITATION_PATTERN = /\[\^ev:([^\]\n]+)\]/g;

export type BrainInlineLinkKind = "page" | "evidence" | "source";

export type BrainInlineLink = {
  raw: string;
  kind: BrainInlineLinkKind;
  target: string;
  label: string;
  index: number;
  valid: boolean;
  legacy: boolean;
};

export function parseBrainInlineLinks(text: string): BrainInlineLink[] {
  const links: BrainInlineLink[] = [];
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

export function formatBrainPageLink(id: string, label?: string): string {
  return formatBracketLink("page", id, label);
}

export function formatBrainEvidenceLink(id: string, label?: string): string {
  return formatBracketLink("evidence", id, label);
}

export function formatBrainSourceLink(ref: string, label?: string): string {
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

export function isValidBrainInlineLinkTarget(kind: BrainInlineLinkKind, target: string): boolean {
  return isValidInlineLinkTarget(kind, target);
}

function parseBracketTarget(value: string): {
  kind: BrainInlineLinkKind;
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
  kind: BrainInlineLinkKind,
  target: string,
  label: string | undefined,
): string {
  const normalizedTarget = target.trim();
  if (!isValidInlineLinkTarget(kind, normalizedTarget)) {
    throw new Error(`Invalid opencompany Brain ${kind} link target.`);
  }
  const normalizedLabel = label?.trim();
  if (normalizedLabel && !isValidInlineLinkLabel(normalizedLabel)) {
    throw new Error("Invalid opencompany Brain link label.");
  }
  return normalizedLabel
    ? `[[${kind}:${normalizedTarget}|${normalizedLabel}]]`
    : `[[${kind}:${normalizedTarget}]]`;
}

function inlineLinkTargets(text: string, kind: BrainInlineLinkKind): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const link of parseBrainInlineLinks(text)) {
    if (link.kind !== kind || !link.valid || seen.has(link.target)) continue;
    seen.add(link.target);
    targets.push(link.target);
  }
  return targets;
}

function isValidInlineLinkTarget(kind: BrainInlineLinkKind, target: string): boolean {
  switch (kind) {
    case "page":
      return isValidBrainId(target);
    case "evidence":
      return isValidBrainEvidenceId(target);
    case "source":
      return isValidBrainSourceRef(target);
  }
}

function isValidInlineLinkLabel(label: string): boolean {
  return label.trim().length > 0 && !/[\[\]\n]/.test(label);
}

type TextRange = { start: number; end: number };
type ListContext = { markerIndent: number; contentIndent: number };

function markdownCodeRanges(text: string): TextRange[] {
  const fencedRanges: TextRange[] = [];
  let openFence: {
    start: number;
    marker: "`" | "~";
    length: number;
    quoteDepth: number;
    listContentIndent: number | null;
    listMarkerIndent: number | null;
  } | null = null;
  const listContexts: ListContext[] = [];
  let previousLineBlank = true;
  let inIndentedCode = false;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const nextLineStart = newline === -1 ? text.length : newline + 1;
    const line = text.slice(lineStart, lineEnd);
    const containerLine = stripBlockQuotePrefixes(line);
    const blank = /^[ \t]*\r?$/.test(containerLine);
    let listContext = listContexts.at(-1) ?? null;
    let closedFence = false;

    if (openFence && fenceContainerEnded(openFence, line, blank, previousLineBlank)) {
      fencedRanges.push({ start: openFence.start, end: lineStart });
      openFence = null;
      inIndentedCode = false;
      const indent = leadingIndent(containerLine);
      while (listContexts.length > 0 && indent < (listContexts.at(-1)?.contentIndent ?? 0)) {
        listContexts.pop();
      }
      listContext = listContexts.at(-1) ?? null;
    }

    if (openFence) {
      const closing = fenceRun(line, listContext, true);
      if (closing?.[0] === openFence.marker && closing.length >= openFence.length) {
        fencedRanges.push({ start: openFence.start, end: nextLineStart });
        openFence = null;
        closedFence = true;
      }
    } else {
      const nextListContext = listContextForLine(containerLine);
      if (nextListContext) {
        while (
          listContexts.length > 0 &&
          (listContexts.at(-1)?.markerIndent ?? -1) >= nextListContext.markerIndent
        ) {
          listContexts.pop();
        }
        listContexts.push(nextListContext);
      } else if (!blank && previousLineBlank) {
        const indent = leadingIndent(containerLine);
        while (listContexts.length > 0 && indent < (listContexts.at(-1)?.contentIndent ?? 0)) {
          listContexts.pop();
        }
      }
      listContext = listContexts.at(-1) ?? null;

      const markerRun = fenceRun(line, listContext, false);
      if (markerRun) {
        openFence = {
          start: lineStart,
          marker: markerRun[0] as "`" | "~",
          length: markerRun.length,
          quoteDepth: blockQuoteDepth(line),
          listContentIndent: listContext?.contentIndent ?? null,
          listMarkerIndent: listContext?.markerIndent ?? null,
        };
        inIndentedCode = false;
      } else if (!blank) {
        const requiredIndent = (listContext?.contentIndent ?? 0) + 4;
        const indented = leadingIndent(containerLine) >= requiredIndent;
        if (indented && (inIndentedCode || previousLineBlank)) {
          fencedRanges.push({ start: lineStart, end: nextLineStart });
          inIndentedCode = true;
        } else {
          inIndentedCode = false;
        }
      }
    }

    previousLineBlank = blank || closedFence;

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

function fenceRun(line: string, listContext: ListContext | null, closing: boolean): string | null {
  let content = stripBlockQuotePrefixes(line).replace(/\r$/, "");

  const listMarker = /^( *)(?:[-+*]|\d{1,9}[.)])([ \t]+)/.exec(content);
  if (listMarker) {
    content = content.slice(listMarker[0].length);
  } else if (listContext) {
    content = content.slice(Math.min(listContext.contentIndent, leadingIndent(content)));
  }

  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
  const marker = match?.[1];
  if (!marker) return null;
  const rest = match?.[2] ?? "";
  if (closing) return /^[ \t]*$/.test(rest) ? marker : null;
  return marker[0] === "`" && rest.includes("`") ? null : marker;
}

function fenceContainerEnded(
  fence: {
    quoteDepth: number;
    listContentIndent: number | null;
    listMarkerIndent: number | null;
  },
  line: string,
  blank: boolean,
  previousLineBlank: boolean,
): boolean {
  if (blockQuoteDepth(line) < fence.quoteDepth) return true;
  if (blank || fence.listContentIndent === null) return false;
  const containerLine = stripBlockQuotePrefixes(line, fence.quoteDepth);
  const indent = leadingIndent(containerLine);
  if (indent >= fence.listContentIndent) return false;
  const nextList = listContextForLine(containerLine);
  if (
    nextList &&
    fence.listMarkerIndent !== null &&
    nextList.markerIndent <= fence.listMarkerIndent
  ) {
    return true;
  }
  if (previousLineBlank || blockQuoteDepth(line) > fence.quoteDepth) return true;
  return interruptsLazyListContinuation(containerLine);
}

function interruptsLazyListContinuation(line: string): boolean {
  const content = line.trimStart();
  return (
    /^#{1,6}(?:[ \t]+|$)/.test(content) ||
    /^(?:`{3,}|~{3,})/.test(content) ||
    /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(content) ||
    /^<(?:[a-z].*>|!--)/i.test(content)
  );
}

function blockQuoteDepth(line: string): number {
  let content = line;
  let depth = 0;
  while (true) {
    const quote = /^ {0,3}>[ \t]?/.exec(content);
    if (!quote) return depth;
    depth += 1;
    content = content.slice(quote[0].length);
  }
}

function stripBlockQuotePrefixes(line: string, maxDepth = Number.POSITIVE_INFINITY): string {
  let content = line;
  let depth = 0;
  while (depth < maxDepth) {
    const quote = /^ {0,3}>[ \t]?/.exec(content);
    if (!quote) return content;
    depth += 1;
    content = content.slice(quote[0].length);
  }
  return content;
}

function listContextForLine(line: string): ListContext | null {
  const match = /^( *)([-+*]|\d{1,9}[.)])([ \t]+)/.exec(line);
  if (!match) return null;
  const markerIndent = match[1]?.length ?? 0;
  const marker = match[2] ?? "";
  let contentIndent = markerIndent + marker.length;
  for (const character of match[3] ?? "") {
    contentIndent += character === "\t" ? 4 - (contentIndent % 4) : 1;
  }
  return { markerIndent, contentIndent };
}

function leadingIndent(value: string): number {
  let columns = 0;
  for (const character of value) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
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
