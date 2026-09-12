import type { ChatUiMessage } from "@/lib/chat-ui";
import { CODEX_APPROVAL_TOOL_NAME, USE_ACTION_TOOL_NAME } from "@/lib/chat-ui";
import {
  formatDebugValue,
  isRecord,
  isToolPartRecord,
  toolLabel,
  toolNameFromPart,
} from "./assistant-items";

// Every approval in the product — a coding engine asking to run a command, a connected
// integration about to write to Linear or Gmail, a metered lookup that costs money — gets the
// same card. This module turns the very different tool inputs behind those requests into one
// shape the card can render, so the decision always reads the same way.

export type ApprovalKind = "terminal" | "files" | "network" | "integration" | "capability";

export type ApprovalDetailLine = { label: string; value: string };

export type ApprovalPresentation = {
  kind: ApprovalKind;
  /** Where the request comes from, shown next to the icon: "Terminal", "Linear", "Files". */
  source: string;
  /** The decision itself, phrased as a question. */
  question: string;
  /** The engine's own explanation, when it says more than the command or paths already do. */
  description: string | null;
  /** A command or payload reproduced verbatim in a monospace block. */
  code: string | null;
  /** File paths the call would touch. */
  paths: string[];
  /** The request's structured fields, one row each. */
  lines: ApprovalDetailLine[];
};

/** The minimum a banner needs to say which decision is waiting and point back at its card. */
export type PendingApproval = {
  approvalId: string;
  source: string;
  question: string;
};

const APPROVAL_CODE_MAX_CHARS = 2_000;

/**
 * The approvals in a message that are still waiting on the user. Mirrors the gate the tool row
 * uses to render a decision card, so the banner can never advertise a decision that has no card.
 */
export function pendingApprovals(message: ChatUiMessage): PendingApproval[] {
  const parts = message.parts as readonly (Record<string, unknown> & { type: string })[];
  return parts.flatMap((part) => {
    if (!isToolPartRecord(part)) return [];
    const name = toolNameFromPart(part);
    if (name !== USE_ACTION_TOOL_NAME && name !== CODEX_APPROVAL_TOOL_NAME) return [];
    if (part.state !== "approval-requested") return [];
    const approvalId = isRecord(part.approval) ? readString(part.approval.id) : null;
    if (!approvalId) return [];
    const presentation = approvalPresentation(part.input);
    return [{ approvalId, source: presentation.source, question: presentation.question }];
  });
}

/**
 * Coding-engine permission requests and connected-action approvals both arrive as tool inputs
 * carrying an `action`, so they are told apart by the fields only one of them has: gateway
 * actions always carry a `params` record, ACP permissions carry the engine's `title`/`rawInput`.
 */
export function isCodingApprovalInput(input: unknown): boolean {
  if (!isRecord(input) || isRecord(input.params)) return false;
  return input.label === "Approval" || isRecord(input.rawInput) || typeof input.title === "string";
}

export function approvalPresentation(input: unknown): ApprovalPresentation {
  return isCodingApprovalInput(input)
    ? codingApprovalPresentation(isRecord(input) ? input : {})
    : actionApprovalPresentation(input);
}

function codingApprovalPresentation(input: Record<string, unknown>): ApprovalPresentation {
  const rawInput = isRecord(input.rawInput) ? input.rawInput : {};
  const command = readString(rawInput.command) ?? commandFromAction(input.action);
  const paths = approvalPaths(input.locations);
  const kind = codingApprovalToolKind(input.kind, { command, paths });
  const title = readString(input.title);
  const code = command ? truncateCode(command) : null;
  return {
    kind: CODING_KIND_PRESENTATION[kind].kind,
    source: CODING_KIND_PRESENTATION[kind].source,
    question: CODING_KIND_PRESENTATION[kind].question,
    description: title && title !== command ? title : null,
    code,
    paths,
    // A permission request without a command or a path would otherwise be an unanswerable
    // question, so fall back to whatever the engine did send.
    lines: code || paths.length > 0 ? [] : approvalParamLines(rawInput),
  };
}

type CodingApprovalToolKind = "execute" | "edit" | "delete" | "move" | "read" | "fetch" | "other";

const CODING_KIND_PRESENTATION: Record<
  CodingApprovalToolKind,
  { kind: ApprovalKind; source: string; question: string }
> = {
  execute: { kind: "terminal", source: "Terminal", question: "Run this command?" },
  edit: { kind: "files", source: "Files", question: "Apply these file changes?" },
  delete: { kind: "files", source: "Files", question: "Delete these files?" },
  move: { kind: "files", source: "Files", question: "Move these files?" },
  read: { kind: "files", source: "Files", question: "Read these files?" },
  fetch: { kind: "network", source: "Network", question: "Fetch this from the web?" },
  other: { kind: "terminal", source: "Coding engine", question: "Allow this tool call?" },
};

/**
 * The ACP tool kind is only present on approvals recorded after it started being forwarded, so
 * older transcripts and any engine that omits it fall back to what the request itself shows.
 */
function codingApprovalToolKind(
  value: unknown,
  request: { command: string | null; paths: string[] },
): CodingApprovalToolKind {
  const kind = readString(value);
  if (kind === "execute") return "execute";
  if (kind === "edit" || kind === "delete" || kind === "move" || kind === "read") return kind;
  if (kind === "fetch" || kind === "search") return "fetch";
  if (request.command) return "execute";
  return request.paths.length > 0 ? "edit" : "other";
}

function actionApprovalPresentation(input: unknown): ApprovalPresentation {
  const record = isRecord(input) ? input : {};
  const action = readString(record.action) ?? "";
  const params = isRecord(record.params) ? record.params : {};
  const source = actionSourceLabel(action);

  if (action === "google_calendar.create_event") {
    return {
      ...emptyActionPresentation(source),
      question: "Add this event to your Google Calendar?",
      lines: calendarEventLines(params),
    };
  }

  if (action === "x_account.post_tweet") {
    const lines = tweetLines(params);
    if (lines.length > 0) {
      return { ...emptyActionPresentation(source), question: "Post to X?", lines };
    }
  }

  return {
    ...emptyActionPresentation(source),
    question: actionQuestion(action, source),
    lines: approvalParamLines(params),
  };
}

function emptyActionPresentation(source: string): ApprovalPresentation {
  return {
    kind: "integration",
    source,
    question: "Run this action?",
    description: null,
    code: null,
    paths: [],
    lines: [],
  };
}

/** Reads "Linear" out of `plugin:linear:linear.create_issue` and "X" out of `x_account.post_tweet`. */
export function actionSourceLabel(action: string): string {
  const slug = actionSourceSlug(action);
  if (!slug) return "Action";
  if (slug.startsWith("custom-")) return "Custom integration";
  return toolLabel(slug.replace(/_account$/u, ""));
}

function actionSourceSlug(action: string): string {
  const pluginMatch = /^plugin:([^:]+):/u.exec(action);
  return pluginMatch?.[1] ?? action.split(".", 1)[0] ?? "";
}

function actionQuestion(action: string, source: string): string {
  const name = action.includes(".") ? (action.split(".").at(-1) ?? "") : "";
  const words = name.split("_").filter(Boolean);
  // Gateways namespace their tools ("slack.slack_search_..."), and the header already names the
  // integration, so repeating it in the question would only make it harder to read.
  const slug = actionSourceSlug(action).replace(/_account$/u, "");
  if (words[0]?.toLowerCase() === slug.toLowerCase()) words.shift();
  const verb = words.join(" ");
  if (!verb) return "Run this action?";
  return source === "Action" ? `Run ${verb}?` : `Run ${verb} in ${source}?`;
}

function calendarEventLines(params: Record<string, unknown>): ApprovalDetailLine[] {
  const lines: ApprovalDetailLine[] = [];
  const summary = readString(params.summary);
  if (summary) lines.push({ label: "Event", value: summary });
  const when = formatEventWindow(params.start, params.end, params.time_zone);
  if (when) lines.push({ label: "When", value: when });
  const location = readString(params.location);
  if (location) lines.push({ label: "Where", value: location });
  if (Array.isArray(params.attendees) && params.attendees.length > 0) {
    lines.push({
      label: "Invites",
      value: params.attendees.filter((entry) => typeof entry === "string").join(", "),
    });
  }
  const calendarId = readString(params.calendar_id);
  if (calendarId && calendarId !== "primary") lines.push({ label: "Calendar", value: calendarId });
  const account = readString(params.account);
  if (account) lines.push({ label: "Account", value: account });
  return lines;
}

function tweetLines(params: Record<string, unknown>): ApprovalDetailLine[] {
  const posts = Array.isArray(params.posts)
    ? params.posts.flatMap((post) => {
        if (!isRecord(post)) return [];
        const text = readString(post.text);
        if (!text) return [];
        const account = readString(post.account);
        return [{ label: "Post", value: account ? `${account} — ${text}` : text }];
      })
    : [];
  const text = readString(params.text);
  if (text) posts.push({ label: "Post", value: text });
  return posts;
}

function approvalParamLines(params: Record<string, unknown>): ApprovalDetailLine[] {
  return Object.entries(params).flatMap(([key, value]) => {
    if (value === undefined || value === null) return [];
    const rendered = formatApprovalValue(value);
    return rendered ? [{ label: key.split("_").join(" "), value: rendered }] : [];
  });
}

function formatApprovalValue(value: unknown): string {
  if (!Array.isArray(value)) return formatDebugValue(value);
  if (value.every((entry) => ["string", "number", "boolean"].includes(typeof entry))) {
    return value.join(", ");
  }
  return formatDebugValue(value);
}

function approvalPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const path = isRecord(entry) ? readString(entry.path) : readString(entry);
    return path ? [path] : [];
  });
}

/**
 * ACP falls back to the tool name when a permission request carries no command, and a bare name
 * like "Bash" is not a command the user can read and judge.
 */
function commandFromAction(value: unknown): string | null {
  const action = readString(value);
  return action?.includes(" ") ? action : null;
}

function truncateCode(value: string): string {
  const command = value.trim();
  return command.length > APPROVAL_CODE_MAX_CHARS
    ? `${command.slice(0, APPROVAL_CODE_MAX_CHARS)}…`
    : command;
}

export function formatEventWindow(start: unknown, end: unknown, timeZone: unknown): string | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
  if (allDay) {
    return start === end ? `${start} (all day)` : `${start} – ${end} (all day)`;
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return `${start} – ${end}`;
  }
  const zone = typeof timeZone === "string" && timeZone ? timeZone : undefined;
  try {
    const dayFormat = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      ...(zone ? { timeZone: zone } : {}),
    });
    const timeFormat = new Intl.DateTimeFormat(undefined, {
      timeStyle: "short",
      ...(zone ? { timeZone: zone } : {}),
    });
    const sameDay = dayFormat.format(startDate) === dayFormat.format(endDate);
    return sameDay
      ? `${dayFormat.format(startDate)}, ${timeFormat.format(startDate)} – ${timeFormat.format(endDate)}`
      : `${dayFormat.format(startDate)} ${timeFormat.format(startDate)} – ${dayFormat.format(endDate)} ${timeFormat.format(endDate)}`;
  } catch {
    return `${start} – ${end}`;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
