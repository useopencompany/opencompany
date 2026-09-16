import { integrations } from "@opencompany/db/product-schema";
import { and, eq } from "drizzle-orm";
import { googleApiCall } from "./google-access-token";

// Reads the connected Gmail account's own labels. Labels back the `email.received` event filter,
// which is the whole reason a workflow author can narrow an arriving email without opencompany
// re-implementing Gmail's matching rules.

const GMAIL_LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels";

export type GmailLabel = { id: string; name: string; type: string | null };

export type GmailSourceAccount = { integrationId: string; userWorkosId: string };

// Resolves the caller's own Gmail connection. A workspace-scoped row never backs an event trigger,
// and a disconnected one has no credential left to read with.
export async function loadOwnGmailAccount(
  userWorkosId: string,
  integrationId: string,
  db: any,
): Promise<GmailSourceAccount | null> {
  const [row] = await db
    .select({
      integrationId: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
      workspaceId: integrations.workspaceId,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, integrationId),
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.provider, "gmail"),
      ),
    )
    .limit(1);
  if (!row || row.workspaceId || row.status === "disconnected") return null;
  return { integrationId: row.integrationId, userWorkosId: row.userWorkosId };
}

// `users.labels.list` is unpaginated and returns the account's full label set in one read.
export async function listGmailLabels(input: {
  account: GmailSourceAccount;
  signal?: AbortSignal;
}): Promise<GmailLabel[]> {
  const response = await googleApiCall(
    { ...input.account, provider: "gmail" },
    "GET",
    new URL(GMAIL_LABELS_URL),
    input.signal ? { signal: input.signal } : undefined,
  );
  const labels = isRecord(response) && Array.isArray(response.labels) ? response.labels : [];
  return labels.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = readString(entry.id);
    const name = readString(entry.name);
    if (!id || !name) return [];
    return [{ id, name, type: readString(entry.type) }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
