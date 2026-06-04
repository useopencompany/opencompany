import type { TiptapDoc, TiptapNode } from "./types";

// Resolves a body @/# mention token to the node attrs for a Tiptap mention pill,
// or null to leave the token as plain text. Injected so the same parser can be
// driven by the web editor's rich catalog or the runner's config-derived one.
export type MentionResolver = (
  token: string,
  char: "@" | "#",
) => { id: string; label: string } | null;

// A mention trigger (`@`/`#`) only starts a mention when it sits at a word
// boundary: the start of the text, or right after whitespace, an opening
// bracket, or a backtick. Backtick is included so an agent that wraps a mention
// in inline-code (e.g. `` `@opencode` ``) still has it recognized — the save
// path then unwraps the surrounding backticks. Shared by every tokenizer
// (this parser, `extractMentionIds`, and the web editor's auto-mention plugin)
// so the recognition rule never drifts between them.
export const MENTION_BOUNDARY_CHARS_RE = /[\s([{`]/;

// Markers may appear without trailing content because `tiptapDocToBody` trims
// trailing whitespace on save: an empty heading is persisted as "#" rather
// than "# ", and likewise for "- " / "1. ". Allow the text portion to be
// optional so an empty block survives a save -> reload round-trip.
const HEADING_PATTERN = /^(#{1,3})(?: +(.*))?$/;
const BULLET_PATTERN = /^[-*](?: +(.*))?$/;
const ORDERED_PATTERN = /^(\d+)\.(?: +(.*))?$/;

function isBlockStarter(line: string) {
  return HEADING_PATTERN.test(line) || BULLET_PATTERN.test(line) || ORDERED_PATTERN.test(line);
}

// Parse a Markdown body (the subset the agent editor supports: headings, bullet
// and ordered lists, paragraphs with hard breaks) into a Tiptap document,
// converting recognized @/# mention tokens into mention nodes via `resolve`.
// This is the single source of truth shared by the web editor and the runner so
// a runner-built `content` round-trips identically to an editor-built one.
export function buildAgentTiptapDoc(body: string, resolve: MentionResolver): TiptapDoc {
  const normalized = body.replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }

  const lines = normalized.split("\n");
  const blocks: TiptapNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const headingMatch = HEADING_PATTERN.exec(line);
    if (headingMatch) {
      const hashes = headingMatch[1] ?? "#";
      const headingText = headingMatch[2] ?? "";
      blocks.push({
        type: "heading",
        attrs: { level: hashes.length },
        content: parseMentionText(headingText, resolve),
      });
      index += 1;
      continue;
    }

    if (BULLET_PATTERN.test(line) || ORDERED_PATTERN.test(line)) {
      const ordered = ORDERED_PATTERN.test(line);
      const pattern = ordered ? ORDERED_PATTERN : BULLET_PATTERN;
      const items: TiptapNode[] = [];
      let startNumber = 1;
      let firstItem = true;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = pattern.exec(current);
        if (!match) break;
        // Ordered pattern captures the leading number in group 1; bullet
        // pattern captures the item text in group 1. Item text is therefore
        // group 2 for ordered, group 1 for bullet.
        const itemText = ordered ? (match[2] ?? "") : (match[1] ?? "");
        if (ordered && firstItem) {
          startNumber = Number.parseInt(match[1] ?? "1", 10);
          if (!Number.isFinite(startNumber) || startNumber < 1) startNumber = 1;
        }
        firstItem = false;
        items.push({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: parseMentionText(itemText, resolve),
            },
          ],
        });
        index += 1;
      }
      blocks.push(
        ordered
          ? { type: "orderedList", attrs: { start: startNumber }, content: items }
          : { type: "bulletList", content: items },
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (current.trim() === "" || isBlockStarter(current)) break;
      paragraphLines.push(current);
      index += 1;
    }
    blocks.push({
      type: "paragraph",
      content: parseInlineContent(paragraphLines.join("\n"), resolve),
    });
  }

  return {
    type: "doc",
    content: blocks.length > 0 ? blocks : [{ type: "paragraph" }],
  };
}

function parseInlineContent(text: string, resolve: MentionResolver): TiptapNode[] {
  const content: TiptapNode[] = [];
  const lines = text.split("\n");

  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) content.push({ type: "hardBreak" });
    content.push(...parseMentionText(line, resolve));
  });

  return content;
}

function parseMentionText(text: string, resolve: MentionResolver): TiptapNode[] {
  const content: TiptapNode[] = [];
  let cursor = 0;

  for (let index = 0; index < text.length; index += 1) {
    const trigger = text[index];
    if (trigger !== "@" && trigger !== "#") continue;
    if (index > 0 && !MENTION_BOUNDARY_CHARS_RE.test(text[index - 1] ?? "")) continue;

    let end = index + 1;
    while (end < text.length && isMentionChar(text[end] ?? "")) end += 1;

    const rawToken = text.slice(index + 1, end);
    const token = rawToken.replace(/[.,;:!?)}\]]+$/g, "");
    const trailing = rawToken.slice(token.length);
    const resolved = resolve(token, trigger);
    if (!resolved) continue;

    pushText(content, text.slice(cursor, index));
    content.push({
      type: "mention",
      attrs: {
        id: resolved.id,
        label: resolved.label,
        mentionSuggestionChar: trigger,
      },
    });
    pushText(content, trailing);
    cursor = end;
    index = end - 1;
  }

  pushText(content, text.slice(cursor));
  return content;
}

function pushText(content: TiptapNode[], text: string) {
  if (text.length === 0) return;
  content.push({ type: "text", text });
}

function isMentionChar(char: string) {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "_" ||
    char === "." ||
    char === "/" ||
    char === "-"
  );
}
