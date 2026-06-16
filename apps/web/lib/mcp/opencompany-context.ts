import { agentBundleDir } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agentFiles, agents } from "@opencompany/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { normalizeBrainPath } from "@/lib/brain/paths";
import { PERSONAL_BRAIN_SUBDIR } from "@/lib/personal/brain";
import { PERSONAL_MEMORY_SUBDIR } from "@/lib/personal/memory";

const SEARCH_SNIPPET_CHARS = 700;
const FULL_CONTENT_CHARS = 20_000;
const MAX_LIMIT = 20;

export type OpenCompanyMcpScope = {
  workspaceId: string;
  userId: string;
};

export type OpenCompanyContextFile = {
  path: string;
  content: string;
  updatedAt: string;
  sizeBytes: number;
};

export type SearchResult = {
  path: string;
  title: string;
  snippet: string;
  updatedAt: string;
  score: number;
};

export async function searchPersonalMemory(
  scope: OpenCompanyMcpScope,
  input: { query?: string; limit?: number },
): Promise<SearchResult[]> {
  const files = await loadPersonalContextFiles(scope, PERSONAL_MEMORY_SUBDIR);
  return searchFiles(
    files.map((file) => {
      const parsed = parseMemoryDocument(file.content);
      const title = parsed.title || parsed.id || file.path;
      const searchable = [title, parsed.compiledTruth, file.content].join("\n");
      return {
        file,
        title,
        searchable,
        snippetSource: parsed.compiledTruth || file.content,
      };
    }),
    input,
  );
}

export async function getPersonalMemory(
  scope: OpenCompanyMcpScope,
  input: { idOrPath: string },
): Promise<(OpenCompanyContextFile & { title: string; compiledTruth: string }) | null> {
  const wanted = normalizeMemoryLookup(input.idOrPath);
  if (!wanted) return null;
  const files = await loadPersonalContextFiles(scope, PERSONAL_MEMORY_SUBDIR);
  const file =
    files.find((candidate) => candidate.path === wanted) ??
    files.find((candidate) => candidate.path.endsWith(`/${wanted}.md`));
  if (!file) return null;
  const parsed = parseMemoryDocument(file.content);
  return {
    ...file,
    content: truncate(file.content, FULL_CONTENT_CHARS),
    title: parsed.title || parsed.id || file.path,
    compiledTruth: parsed.compiledTruth,
  };
}

export async function searchPersonalBrain(
  scope: OpenCompanyMcpScope,
  input: { query?: string; limit?: number },
): Promise<SearchResult[]> {
  const files = await loadPersonalContextFiles(scope, PERSONAL_BRAIN_SUBDIR);
  return searchFiles(
    files.map((file) => ({
      file,
      title: titleFromMarkdown(file.content) || file.path,
      searchable: file.content,
      snippetSource: file.content,
    })),
    input,
  );
}

export async function getPersonalBrainFile(
  scope: OpenCompanyMcpScope,
  input: { path: string },
): Promise<OpenCompanyContextFile | null> {
  let path: string;
  try {
    path = normalizeBrainPath(input.path);
  } catch {
    return null;
  }
  const files = await loadPersonalContextFiles(scope, PERSONAL_BRAIN_SUBDIR);
  const file = files.find((candidate) => candidate.path === path);
  return file ? { ...file, content: truncate(file.content, FULL_CONTENT_CHARS) } : null;
}

async function loadPersonalContextFiles(
  scope: OpenCompanyMcpScope,
  subdir: typeof PERSONAL_MEMORY_SUBDIR | typeof PERSONAL_BRAIN_SUBDIR,
): Promise<OpenCompanyContextFile[]> {
  const db = getDb();
  const [agent] = await db
    .select({ id: agents.id, path: agents.path })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, scope.workspaceId),
        eq(agents.userId, scope.userId),
        eq(agents.isDefault, true),
      ),
    )
    .limit(1);
  if (!agent?.path) return [];

  const prefix = `${agentBundleDir(agent.path)}/${subdir}/`;
  const rows = await db
    .select({
      path: agentFiles.path,
      content: agentFiles.content,
      sizeBytes: agentFiles.sizeBytes,
      updatedAt: agentFiles.updatedAt,
    })
    .from(agentFiles)
    .where(and(eq(agentFiles.workspaceId, scope.workspaceId), eq(agentFiles.agentId, agent.id)))
    .orderBy(asc(agentFiles.path));

  return rows
    .filter((row) => row.path.startsWith(prefix))
    .map((row) => ({
      path: row.path.slice(prefix.length),
      content: row.content,
      sizeBytes: row.sizeBytes,
      updatedAt: row.updatedAt.toISOString(),
    }));
}

function searchFiles(
  records: Array<{
    file: OpenCompanyContextFile;
    title: string;
    searchable: string;
    snippetSource: string;
  }>,
  input: { query?: string; limit?: number },
): SearchResult[] {
  const query = input.query?.trim().toLowerCase() ?? "";
  const terms = query.split(/\s+/).filter(Boolean);
  const limit = Math.min(Math.max(input.limit ?? 8, 1), MAX_LIMIT);

  return records
    .map((record) => {
      const haystack = `${record.title}\n${record.file.path}\n${record.searchable}`.toLowerCase();
      const score =
        terms.length === 0
          ? 1
          : terms.reduce((total, term) => total + occurrences(haystack, term), 0);
      if (terms.length > 0 && score === 0) return null;
      return {
        path: record.file.path,
        title: record.title,
        snippet: snippet(record.snippetSource, terms),
        updatedAt: record.file.updatedAt,
        score,
      };
    })
    .filter((result): result is SearchResult => result !== null)
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

function normalizeMemoryLookup(value: string) {
  const trimmed = value.trim().replace(/^memory\//, "");
  if (!trimmed) return null;
  if (trimmed.endsWith(".md")) {
    return isSafeRelativePath(trimmed) ? trimmed : null;
  }
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed) ? trimmed : null;
}

function parseMemoryDocument(content: string): {
  id: string;
  title: string;
  compiledTruth: string;
} {
  const body = stripFrontmatter(content);
  return {
    id: readFrontmatterString(content, "id"),
    title: titleFromMarkdown(body),
    compiledTruth: readMarkdownSection(body, "## Compiled truth"),
  };
}

function stripFrontmatter(content: string) {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  return end === -1 ? content : content.slice(end + 4);
}

function readFrontmatterString(content: string, key: string) {
  if (!content.startsWith("---\n")) return "";
  const end = content.indexOf("\n---", 4);
  if (end === -1) return "";
  const frontmatter = content.slice(4, end);
  const re = new RegExp(`^${key}:\\s*["']?([^"'\n]+)["']?\\s*$`, "m");
  return re.exec(frontmatter)?.[1]?.trim() ?? "";
}

function readMarkdownSection(content: string, heading: string) {
  const start = content.search(new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m"));
  if (start === -1) return "";
  const afterHeading = start + heading.length;
  const rest = content.slice(afterHeading);
  const nextHeading = rest.search(/^##\s+/m);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return section.replace(/<!--\s*TIMELINE:BELOW[\s\S]*?-->/g, "").trim();
}

function titleFromMarkdown(content: string) {
  for (const line of content.split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return "";
}

function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith("/")) return false;
  return relativePath.split("/").every((part) => {
    return part.length > 0 && part !== "." && part !== ".." && !part.startsWith(".");
  });
}

function occurrences(haystack: string, term: string) {
  let count = 0;
  let index = haystack.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(term, index + term.length);
  }
  return count;
}

function snippet(content: string, terms: string[]) {
  const text = content.trim() || "_No content._";
  if (text.length <= SEARCH_SNIPPET_CHARS) return text;

  const lower = text.toLowerCase();
  const firstMatch = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max((firstMatch ?? 0) - 160, 0);
  return `${start > 0 ? "... " : ""}${text.slice(start, start + SEARCH_SNIPPET_CHARS).trim()}...`;
}

function truncate(content: string, maxChars: number) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
