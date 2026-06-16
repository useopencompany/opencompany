import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { personalMcpTokens } from "@opencompany/db/schema";
import { and, desc, eq } from "drizzle-orm";

const TOKEN_PREFIX = "oc_mcp_";
const TOKEN_BYTES = 32;

export type PersonalMcpTokenSummary = {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type PersonalMcpTokenAuth = {
  tokenId: string;
  workspaceId: string;
  userId: string;
};

export async function listPersonalMcpTokens(input: {
  workspaceId: string;
  userId: string;
}): Promise<PersonalMcpTokenSummary[]> {
  const rows = await getDb()
    .select({
      id: personalMcpTokens.id,
      label: personalMcpTokens.label,
      createdAt: personalMcpTokens.createdAt,
      updatedAt: personalMcpTokens.updatedAt,
      lastUsedAt: personalMcpTokens.lastUsedAt,
    })
    .from(personalMcpTokens)
    .where(
      and(
        eq(personalMcpTokens.workspaceId, input.workspaceId),
        eq(personalMcpTokens.userId, input.userId),
      ),
    )
    .orderBy(desc(personalMcpTokens.createdAt));

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function createPersonalMcpToken(input: {
  workspaceId: string;
  userId: string;
  label?: string;
}): Promise<{ token: string; summary: PersonalMcpTokenSummary }> {
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  const now = new Date();
  const [row] = await getDb()
    .insert(personalMcpTokens)
    .values({
      id: newPersonalMcpTokenId(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      label: normalizeLabel(input.label),
      tokenHash: hashPersonalMcpToken(token),
      updatedAt: now,
    })
    .returning({
      id: personalMcpTokens.id,
      label: personalMcpTokens.label,
      createdAt: personalMcpTokens.createdAt,
      updatedAt: personalMcpTokens.updatedAt,
      lastUsedAt: personalMcpTokens.lastUsedAt,
    });

  if (!row) throw new Error("Could not create MCP token.");
  return {
    token,
    summary: {
      id: row.id,
      label: row.label,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    },
  };
}

export async function revokePersonalMcpToken(input: {
  workspaceId: string;
  userId: string;
  tokenId: string;
}) {
  await getDb()
    .delete(personalMcpTokens)
    .where(
      and(
        eq(personalMcpTokens.id, input.tokenId),
        eq(personalMcpTokens.workspaceId, input.workspaceId),
        eq(personalMcpTokens.userId, input.userId),
      ),
    );
}

export async function authenticatePersonalMcpToken(
  authorizationHeader: string | null,
): Promise<PersonalMcpTokenAuth | null> {
  const token = readBearerToken(authorizationHeader);
  if (!token?.startsWith(TOKEN_PREFIX)) return null;

  const tokenHash = hashPersonalMcpToken(token);
  const [row] = await getDb()
    .select({
      id: personalMcpTokens.id,
      workspaceId: personalMcpTokens.workspaceId,
      userId: personalMcpTokens.userId,
      tokenHash: personalMcpTokens.tokenHash,
    })
    .from(personalMcpTokens)
    .where(eq(personalMcpTokens.tokenHash, tokenHash))
    .limit(1);

  if (!row || !hashesEqual(row.tokenHash, tokenHash)) return null;

  await getDb()
    .update(personalMcpTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(personalMcpTokens.id, row.id));

  return { tokenId: row.id, workspaceId: row.workspaceId, userId: row.userId };
}

function readBearerToken(header: string | null) {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function hashPersonalMcpToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashesEqual(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeLabel(label?: string) {
  const trimmed = label?.trim();
  if (!trimmed) return "MCP token";
  return trimmed.slice(0, 80);
}

function newPersonalMcpTokenId() {
  return `pmcpt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
