import { AD_HOC_TASK_ID, AD_HOC_TASK_TOKEN } from "@opencompany/core/ad-hoc-task";
import type { SFSymbol } from "expo-symbols";
import { z } from "zod";
import { type QuickActionTint, tokenPresentation } from "./quick-action-symbols";

export type ComposerTokenKind = "plugin" | "repository" | "skill" | "workflow" | "task";

export interface ComposerTextSegment {
  type: "text";
  text: string;
}

/** A tag in the composer. Native draws it; JavaScript turns it into text and mentions. */
export interface ComposerTokenSegment {
  type: "token";
  kind: ComposerTokenKind;
  /** Plugin name, `owner/repo`, skill id, workflow slug, or `task`. */
  id: string;
  label: string;
  symbol: SFSymbol;
  tint?: QuickActionTint;
}

export type ComposerSegment = ComposerTextSegment | ComposerTokenSegment;

/** A tag the server needs to know about beyond its text, like web's selected mentions. */
export interface ComposerMention {
  kind: "skill" | "workflow" | "task";
  id: string;
  name: string;
}

const StoredMentionsSchema = z.array(
  z.object({
    kind: z.enum(["skill", "workflow", "task"]),
    id: z.string().min(1),
    name: z.string().min(1),
  }),
);

/** Mentions saved with a draft. A row this build cannot read keeps its text and loses its tags. */
export const parseStoredMentions = (json: string | null): ComposerMention[] => {
  if (!json) return [];
  try {
    const parsed = StoredMentionsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

export const createToken = (
  kind: ComposerTokenKind,
  id: string,
  label: string,
): ComposerTokenSegment => ({ type: "token", kind, id, label, ...tokenPresentation(kind, id) });

// The same escaping as web `referenceMarkdown`, so a label never breaks out of its link.
const escapeLabel = (label: string) => label.replace(/[\\`*_[\]<>!&]/g, "\\$&");
const unescapeLabel = (label: string) => label.replace(/\\(.)/g, "$1");

// `#task` is the reserved ad-hoc Task command. A workflow whose slug is also `task` keeps a
// distinct handle so picking it can never start an ad-hoc Task instead, as on web.
const workflowHandle = (slug: string) =>
  slug === AD_HOC_TASK_ID ? `${AD_HOC_TASK_ID}-workflow` : slug;

const serializeToken = (token: ComposerTokenSegment): string => {
  switch (token.kind) {
    case "plugin":
      return `[${escapeLabel(token.label)}](/plugins/${token.id})`;
    case "repository":
      return `[${escapeLabel(token.label)}](https://github.com/${token.id})`;
    case "skill":
      return `/${token.label}`;
    case "workflow":
      return `#${workflowHandle(token.id)}`;
    case "task":
      return AD_HOC_TASK_TOKEN;
  }
};

const mentionText = (mention: ComposerMention): string =>
  serializeToken(createToken(mention.kind, mention.id, mention.name));

/** The outgoing text and the mentions it carries. Mentions only exist while their tag does. */
export const serializeSegments = (
  segments: readonly ComposerSegment[],
): { text: string; mentions: ComposerMention[] } => {
  const mentions: ComposerMention[] = [];
  let text = "";
  for (const segment of segments) {
    if (segment.type === "text") {
      text += segment.text;
      continue;
    }
    text += serializeToken(segment);
    // Plugin and repository links say everything in their text.
    if (segment.kind === "plugin" || segment.kind === "repository") continue;
    if (mentions.some((mention) => mention.kind === segment.kind && mention.id === segment.id))
      continue;
    mentions.push({ kind: segment.kind, id: segment.id, name: segment.label });
  }
  return { text, mentions };
};

const REFERENCE_PATTERN =
  /\[((?:\\.|[^\]\\])+)\]\((\/plugins\/[a-z0-9][a-z0-9_-]*|https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\)/g;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface TokenMatch {
  start: number;
  end: number;
  token: ComposerTokenSegment;
}

/**
 * Turns stored draft text back into tags: reference links become plugin or repository tags, and
 * each stored mention claims the first place its text appears as a whole word.
 */
export const parseDraftSegments = (
  text: string,
  mentions: readonly ComposerMention[],
): ComposerSegment[] => {
  const matches: TokenMatch[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const label = unescapeLabel(match[1]!);
    const href = match[2]!;
    const token = href.startsWith("/plugins/")
      ? createToken("plugin", href.slice("/plugins/".length), label)
      : createToken("repository", href.slice("https://github.com/".length), label);
    matches.push({ start: match.index, end: match.index + match[0].length, token });
  }
  const overlaps = (start: number, end: number) =>
    matches.some((match) => start < match.end && match.start < end);
  for (const mention of mentions) {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(mentionText(mention))}(?=\\s|$)`, "gi");
    for (const match of text.matchAll(pattern)) {
      const start = match.index + match[1]!.length;
      const end = match.index + match[0].length;
      if (overlaps(start, end)) continue;
      matches.push({ start, end, token: createToken(mention.kind, mention.id, mention.name) });
      break;
    }
  }
  matches.sort((left, right) => left.start - right.start);

  const segments: ComposerSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor)
      segments.push({ type: "text", text: text.slice(cursor, match.start) });
    segments.push(match.token);
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
  return segments;
};

/** The text a sent message shows: reference links read as their labels. */
export const referenceLabelRanges = (
  text: string,
): { start: number; end: number; label: string }[] =>
  [...text.matchAll(REFERENCE_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    label: unescapeLabel(match[1]!),
  }));
