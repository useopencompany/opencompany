import { goatGoogleJsonRequest } from "@/lib/integrations/google-access-token";
import type { ResolvedGmailAccount } from "./connections";
import type { IntegrationToolExecutor } from "./dispatcher";

// Gmail chat tools: read-only reads against gmail.readonly for one connected
// account per call. Every tool requires the account email so multi-account
// users stay unambiguous; parsing mirrors the runner's gmail-api shapes
// (headers, text parts, quoted-reply stripping).

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export function createGmailIntegrationToolExecutor(input: {
  userWorkosId: string;
  accounts: readonly ResolvedGmailAccount[];
  signal?: AbortSignal;
}): IntegrationToolExecutor {
  const resolveAccount = (accountArg: unknown): ResolvedGmailAccount => {
    const email = typeof accountArg === "string" ? accountArg.trim().toLowerCase() : "";
    const match = input.accounts.find((account) => account.email.toLowerCase() === email);
    if (!match) {
      const connected = input.accounts.map((account) => account.email).join(", ");
      throw new Error(
        `No connected Gmail account matches ${JSON.stringify(String(accountArg ?? ""))}. Connected accounts: ${connected}.`,
      );
    }
    return match;
  };

  const request = <T>(account: ResolvedGmailAccount, url: URL) =>
    goatGoogleJsonRequest<T>({
      account: {
        userWorkosId: input.userWorkosId,
        integrationId: account.integrationId,
        provider: "gmail",
      },
      url,
      ...(input.signal ? { signal: input.signal } : {}),
    });

  return async ({ tool, args }) => {
    const account = resolveAccount(args.account);

    switch (tool.name) {
      case "gmail_search_emails": {
        const listUrl = new URL(`${GMAIL_BASE}/messages`);
        listUrl.searchParams.set("q", String(args.query));
        listUrl.searchParams.set("maxResults", String(clampLimit(args.maxResults, 10, 25)));
        const list = await request<{
          messages?: Array<{ id?: string }>;
          resultSizeEstimate?: number;
        }>(account, listUrl);
        const ids = (list.messages ?? [])
          .map((message) => message.id)
          .filter((id): id is string => Boolean(id));
        const messages = await Promise.all(
          ids.map(async (id) => {
            const url = new URL(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}`);
            url.searchParams.set("format", "metadata");
            for (const header of ["From", "To", "Subject", "Date"]) {
              url.searchParams.append("metadataHeaders", header);
            }
            const message = asRecord(await request<unknown>(account, url));
            const headers = readHeaders(asRecord(message.payload));
            return {
              id: readString(message.id) ?? id,
              threadId: readString(message.threadId),
              from: headers.from ?? null,
              to: headers.to ?? null,
              subject: headers.subject ?? null,
              date: headers.date ?? null,
              snippet: readString(message.snippet),
            };
          }),
        );
        return { account: account.email, messages };
      }
      case "gmail_get_email": {
        const url = new URL(`${GMAIL_BASE}/messages/${encodeURIComponent(String(args.messageId))}`);
        url.searchParams.set("format", "full");
        const message = asRecord(await request<unknown>(account, url));
        return { account: account.email, message: parseFullMessage(message) };
      }
      case "gmail_get_thread": {
        const url = new URL(`${GMAIL_BASE}/threads/${encodeURIComponent(String(args.threadId))}`);
        url.searchParams.set("format", "full");
        const thread = asRecord(await request<unknown>(account, url));
        return {
          account: account.email,
          threadId: readString(thread.id) ?? String(args.threadId),
          messages: asArray(thread.messages).map((entry) => parseFullMessage(asRecord(entry))),
        };
      }
      default:
        throw new Error(`Unsupported Gmail tool ${tool.name}.`);
    }
  };
}

function parseFullMessage(message: Record<string, unknown>) {
  const payload = asRecord(message.payload);
  const headers = readHeaders(payload);
  const rawBody = collectTextParts(payload).join("\n\n").trim();
  return {
    id: readString(message.id),
    threadId: readString(message.threadId),
    from: headers.from ?? null,
    to: headers.to ?? null,
    cc: headers.cc ?? null,
    subject: headers.subject ?? null,
    date: headers.date ?? null,
    snippet: readString(message.snippet),
    body: stripQuotedReply(rawBody),
  };
}

function readHeaders(payload: Record<string, unknown>) {
  const headers: { from?: string; to?: string; cc?: string; subject?: string; date?: string } = {};
  for (const entry of asArray(payload.headers)) {
    const record = asRecord(entry);
    const name = readString(record.name)?.toLowerCase();
    const value = readString(record.value);
    if (!name || !value) continue;
    if (
      name === "from" ||
      name === "to" ||
      name === "cc" ||
      name === "subject" ||
      name === "date"
    ) {
      headers[name] = value;
    }
  }
  return headers;
}

function collectTextParts(part: Record<string, unknown>): string[] {
  const plain = collectPartsByMime(part, "text/plain");
  if (plain.length > 0) return plain;
  // No text/plain anywhere — fall back to crudely-stripped HTML.
  return collectPartsByMime(part, "text/html").map(stripHtml);
}

function collectPartsByMime(part: Record<string, unknown>, wanted: string): string[] {
  const mimeType = readString(part.mimeType);
  const data = readString(asRecord(part.body).data);
  const current = data && (!mimeType || mimeType === wanted) ? [decodeBase64Url(data)] : [];
  const children = asArray(part.parts).flatMap((child) =>
    collectPartsByMime(asRecord(child), wanted),
  );
  return [...current, ...children].filter((text) => text.trim());
}

function stripHtml(html: string) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Best-effort quoted-reply removal, mirroring the runner's gmail-api helper:
// keeping too much is the safe failure mode.
function stripQuotedReply(body: string): string {
  const lines = body.split("\n");
  let cut = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (/^On .{4,200} wrote:$/.test(line) || /^-{2,}\s*Original Message\s*-{0,}$/i.test(line)) {
      cut = index;
      break;
    }
    if (line.startsWith(">")) {
      const next = lines[index + 1]?.trim();
      if (next === undefined || next.startsWith(">") || next === "") {
        cut = index;
        break;
      }
    }
  }
  return lines.slice(0, cut).join("\n").trim() || body.trim();
}

function decodeBase64Url(data: string) {
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function clampLimit(value: unknown, fallback: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}
