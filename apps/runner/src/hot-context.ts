import { agentBundleDir } from "@opencompany/agent-runtime";
import {
  agentFiles,
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
} from "@opencompany/db/schema";
import { isCanonicalType, parseDocument } from "@opencompany/memory";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { RunContext } from "./run-context";

const HOT_CONTEXT_SNAPSHOT_EVENT = "hot_context.snapshot";
export const HOT_CONTEXT_TOKEN_CAP = 2000;

type AgentFileRow = {
  path: string;
  content: string;
  updatedAt?: Date | null;
};

type HotContextSource = {
  agentPath: string | null;
  agentFiles: AgentFileRow[];
  latestKeeperSummary?: string | undefined;
};

export type HotContextStore = {
  loadSnapshot(sessionId: string): Promise<string | undefined>;
  saveSnapshot(sessionId: string, block: string): Promise<string>;
  loadLatestKeeperSummary(input: {
    workspaceId: string;
    userId: string;
    agentId: string;
  }): Promise<string | undefined>;
};

export function createDbHotContextStore(db: RunContext["db"]): HotContextStore {
  return {
    async loadSnapshot(sessionId) {
      return loadSnapshotFromDb(db, sessionId);
    },
    async saveSnapshot(sessionId, block) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM agent_sessions WHERE id = ${sessionId} FOR UPDATE`);
        const existing = await loadSnapshotFromDb(tx, sessionId);
        if (existing !== undefined) return existing;

        await tx.insert(agentSessionEvents).values({
          sessionId,
          type: HOT_CONTEXT_SNAPSHOT_EVENT,
          payload: { block },
        });
        return block;
      });
    },
    async loadLatestKeeperSummary(input) {
      const rows = await db
        .select({ content: agentSessionMessages.content })
        .from(agentSessionMessages)
        .innerJoin(agentSessions, eq(agentSessionMessages.sessionId, agentSessions.id))
        .where(
          and(
            eq(agentSessions.workspaceId, input.workspaceId),
            eq(agentSessions.userId, input.userId),
            eq(agentSessions.agentId, input.agentId),
            eq(agentSessions.source, "memory"),
            eq(agentSessionMessages.role, "assistant"),
            eq(agentSessionMessages.status, "completed"),
          ),
        )
        .orderBy(desc(agentSessionMessages.completedAt), desc(agentSessionMessages.createdAt))
        .limit(1);
      return summarizeLine(rows[0]?.content);
    },
  };
}

async function loadSnapshotFromDb(db: RunContext["db"], sessionId: string) {
  const rows = await db
    .select({ payload: agentSessionEvents.payload })
    .from(agentSessionEvents)
    .where(
      and(
        eq(agentSessionEvents.sessionId, sessionId),
        eq(agentSessionEvents.type, HOT_CONTEXT_SNAPSHOT_EVENT),
      ),
    )
    .orderBy(asc(agentSessionEvents.id))
    .limit(1);
  const block = rows[0]?.payload?.block;
  return typeof block === "string" ? block : undefined;
}

export async function loadSessionHotContextBlock(input: {
  enabled: boolean;
  sessionId: string;
  store: HotContextStore;
  buildSource: () => Promise<HotContextSource>;
}): Promise<string | null> {
  if (!input.enabled) return null;

  const existing = await input.store.loadSnapshot(input.sessionId);
  if (existing !== undefined) return existing.trim() ? existing : null;

  const block = buildHotContextBlock(await input.buildSource()) ?? "";
  const snapshot = await input.store.saveSnapshot(input.sessionId, block);
  return snapshot.trim() ? snapshot : null;
}

export function loadAgentFilesForHotContext(input: {
  db: RunContext["db"];
  workspaceId: string;
  agentId: string;
}): Promise<AgentFileRow[]> {
  return input.db
    .select({
      path: agentFiles.path,
      content: agentFiles.content,
      updatedAt: agentFiles.updatedAt,
    })
    .from(agentFiles)
    .where(
      and(eq(agentFiles.workspaceId, input.workspaceId), eq(agentFiles.agentId, input.agentId)),
    );
}

export function prependHotContextBlock(
  systemPrompt: string,
  hotContextBlock: string | null,
): string {
  return hotContextBlock ? `${hotContextBlock}\n\n${systemPrompt}` : systemPrompt;
}

export function buildHotContextBlock(source: HotContextSource): string | null {
  if (!source.agentPath) return null;
  const bundleDir = agentBundleDir(source.agentPath);
  const profile = source.agentFiles.find((file) => file.path === `${bundleDir}/user.md`);
  const memories = readMemoryDocuments(source.agentFiles, bundleDir);

  const sections = [
    section("User identity digest", summarizeProfile(profile?.content)),
    section("Active projects / current focus", activeProjectLines(memories)),
    section("Hard constraints / standing preferences", preferenceLines(memories)),
    section("Most recent keeper summary", summarizeLine(source.latestKeeperSummary)),
  ].filter((value): value is string => Boolean(value));

  if (sections.length === 0) return null;

  const open = "<hot-context>\n";
  const close = "\n</hot-context>";
  const bodyBudget = HOT_CONTEXT_TOKEN_CAP - estimateTokenCount(open + close);
  const body = truncateToEstimatedTokens(sections.join("\n\n"), bodyBudget);
  const block = `${open}${body}${close}`;
  return estimateTokenCount(block) <= HOT_CONTEXT_TOKEN_CAP
    ? block
    : `${open}${truncateToEstimatedTokens(body, bodyBudget - 1)}${close}`;
}

function readMemoryDocuments(files: AgentFileRow[], bundleDir: string) {
  const prefix = `${bundleDir}/memory/`;
  return files
    .filter((file) => file.path.startsWith(prefix) && !file.path.includes("/evidence/"))
    .map((file) => {
      const parsed = parseDocument(file.content);
      const type = parsed.frontmatter.type;
      if (!isCanonicalType(type)) return null;
      const status = parsed.frontmatter.status;
      if (status === "deprecated" || status === "merged") return null;
      const updatedAt = readDate(parsed.frontmatter.updatedAt) ?? file.updatedAt ?? null;
      return {
        title: parsed.title.trim() || String(parsed.frontmatter.id ?? ""),
        type,
        compiledTruth: normalizeText(parsed.compiledTruth),
        updatedAt,
      };
    })
    .filter((doc): doc is NonNullable<typeof doc> => Boolean(doc));
}

function activeProjectLines(memories: ReturnType<typeof readMemoryDocuments>): string[] {
  return memories
    .filter((doc) => doc.type === "project" && doc.compiledTruth)
    .sort(byUpdatedDesc)
    .slice(0, 2)
    .map((doc) => `- ${doc.title}: ${truncateChars(stripCitations(doc.compiledTruth), 320)}`);
}

function preferenceLines(memories: ReturnType<typeof readMemoryDocuments>): string[] {
  const preferencePattern =
    /\b(preference|prefers|constraint|standing|style|workflow|convention|always|never|must)\b/i;
  return memories
    .filter(
      (doc) => doc.compiledTruth && preferencePattern.test(`${doc.title} ${doc.compiledTruth}`),
    )
    .sort(byUpdatedDesc)
    .slice(0, 4)
    .map((doc) => `- ${doc.title}: ${truncateChars(stripCitations(doc.compiledTruth), 260)}`);
}

function summarizeProfile(content: string | undefined): string | null {
  const trimmed = normalizeText(content ?? "");
  return trimmed ? truncateChars(stripCitations(trimmed), 1800) : null;
}

function section(title: string, body: string | string[] | null | undefined): string | null {
  const lines = Array.isArray(body) ? body.filter(Boolean) : body ? [body] : [];
  if (lines.length === 0) return null;
  return [`## ${title}`, ...lines].join("\n");
}

function summarizeLine(text: string | null | undefined): string | undefined {
  const normalized = normalizeText(text ?? "");
  return normalized ? truncateChars(normalized, 280) : undefined;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripCitations(text: string): string {
  return text
    .replace(/\[\^ev:[a-z0-9][a-z0-9-]{0,63}\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - " [truncated]".length)).trimEnd()} [truncated]`;
}

function truncateToEstimatedTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokenCount(text) <= maxTokens) return text;
  const marker = "\n[truncated]";
  const markerTokens = estimateTokenCount(marker);
  const budget = Math.max(0, maxTokens - markerTokens);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokenCount(text.slice(0, mid)) <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${text.slice(0, low).trimEnd()}${marker}`;
}

function estimateTokenCount(text: string): number {
  const nonWhitespace = text.match(/\S+/g)?.length ?? 0;
  return Math.max(nonWhitespace, Math.ceil(text.length / 3));
}

function byUpdatedDesc(a: { updatedAt: Date | null }, b: { updatedAt: Date | null }): number {
  return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const __test = {
  buildHotContextBlock,
  estimateTokenCount,
  HOT_CONTEXT_SNAPSHOT_EVENT,
};
