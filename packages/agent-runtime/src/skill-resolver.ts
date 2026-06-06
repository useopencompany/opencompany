import { parse as parseYaml } from "yaml";
import { computeSkillFolderIntegrity, isKnownAgentSkillId, isValidSkillMountId } from "./skills";
import type { AgentSkillFile, AgentSkillSource } from "./types";

// Limits applied to every resolve / re-resolve. Skills are small text bundles; anything
// larger is almost certainly not a skill (or is hostile) and is rejected.
export const SKILL_RESOLVER_LIMITS = {
  maxFileCount: 32,
  maxTotalBytes: 256 * 1024,
  maxFileBytes: 256 * 1024,
  // Cap on how many candidate SKILL.md files we'll read to build a chooser, so a repo with
  // hundreds of skills can't fan out into hundreds of requests.
  maxCandidateReads: 25,
};

export class SkillResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillResolverError";
  }
}

export type ParsedSkillUrl = {
  sourceType: AgentSkillSource["type"];
  owner: string;
  repo: string;
  // Canonical https repository url (always github.com, even for skills.sh sources).
  url: string;
  // Explicit ref from the URL, if any (otherwise the default branch is used).
  ref?: string;
  // Explicit skill directory subpath from the URL, if any.
  subpath?: string;
  // skills.sh slug used to pick a skill by name when the repo has several.
  nameFilter?: string;
};

// A GitHub tree entry, as the resolver needs it. Fetchers map the GitHub API shape onto this.
export type SkillTreeEntry = {
  path: string;
  type: "blob" | "tree";
  // Git mode string. "120000" is a symlink and is rejected.
  mode: string;
  size?: number;
};

// Network boundary. Web and runner supply concrete implementations (unauthenticated GitHub
// requests to api.github.com / raw.githubusercontent.com only). Keeping it injected makes the
// resolver pure and unit-testable, and keeps the SSRF surface in one small place.
export type SkillResolverFetcher = {
  defaultBranch(owner: string, repo: string): Promise<string>;
  // Returns the 40-hex commit sha for a ref, or null if the ref/repo can't be read.
  resolveCommit(owner: string, repo: string, ref: string): Promise<string | null>;
  fetchTree(owner: string, repo: string, commit: string): Promise<SkillTreeEntry[]>;
  fetchBlob(owner: string, repo: string, commit: string, path: string): Promise<string>;
};

export type SkillCandidate = {
  // Skill directory path within the repo, "" = repository root.
  path: string;
  name: string;
  description: string;
  // Optional slash-command slug declared in SKILL.md frontmatter (`command:`). When present,
  // the composer surfaces a `/<command>` slash command for this skill on agents that enable it.
  command?: string;
};

export type ResolvedSkill = {
  skillId: string;
  name: string;
  description: string;
  command?: string;
  source: AgentSkillSource;
  resolvedCommit: string;
  integrity: string;
  files: AgentSkillFile[];
  fileCount: number;
  totalBytes: number;
};

export type ResolveSkillResult =
  | { status: "resolved"; skill: ResolvedSkill }
  // More than one skill in the repo and the caller didn't pick one: present these.
  | {
      status: "ambiguous";
      candidates: SkillCandidate[];
      source: Pick<AgentSkillSource, "type" | "url" | "ref">;
      resolvedCommit: string;
    };

// SSRF boundary: this fetcher only ever talks to these two hosts. Owner/repo come from the
// validated parser and commit is a hex sha, so no user-controlled value reaches the host.
const GITHUB_API_HOST = "https://api.github.com";
const GITHUB_RAW_HOST = "https://raw.githubusercontent.com";

function githubApiHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "opencompany-skills",
  };
}

function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// Unauthenticated GitHub fetcher for public repositories (V1). A private repo or bad URL reads
// as 404 and surfaces as a clean "couldn't read that repository" error. Shared by web and runner.
export function createGitHubSkillFetcher(): SkillResolverFetcher {
  return {
    async defaultBranch(owner, repo) {
      const response = await fetch(
        `${GITHUB_API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        { headers: githubApiHeaders() },
      );
      if (!response.ok) {
        throw new Error(`Couldn't read repository ${owner}/${repo} (${response.status}).`);
      }
      const json = (await response.json()) as { default_branch?: string };
      return json.default_branch ?? "main";
    },
    async resolveCommit(owner, repo, ref) {
      const response = await fetch(
        `${GITHUB_API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
        { headers: githubApiHeaders() },
      );
      if (response.status === 404 || response.status === 422) return null;
      if (!response.ok) {
        throw new Error(`Couldn't resolve ${owner}/${repo}@${ref} (${response.status}).`);
      }
      const json = (await response.json()) as { sha?: string };
      return typeof json.sha === "string" ? json.sha : null;
    },
    async fetchTree(owner, repo, commit) {
      const response = await fetch(
        `${GITHUB_API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${commit}?recursive=1`,
        { headers: githubApiHeaders() },
      );
      if (!response.ok) {
        throw new Error(`Couldn't read repository tree (${response.status}).`);
      }
      const json = (await response.json()) as {
        tree?: Array<{ path?: string; type?: string; mode?: string; size?: number }>;
      };
      const entries = Array.isArray(json.tree) ? json.tree : [];
      return entries.flatMap<SkillTreeEntry>((entry) => {
        if (typeof entry.path !== "string" || typeof entry.mode !== "string") return [];
        // Only files and directories are mountable. Drop anything else (notably submodules,
        // which come back as type "commit") rather than misclassifying them as blobs and then
        // trying to fetch their contents.
        if (entry.type !== "blob" && entry.type !== "tree") return [];
        return [
          {
            path: entry.path,
            type: entry.type,
            mode: entry.mode,
            ...(typeof entry.size === "number" ? { size: entry.size } : {}),
          },
        ];
      });
    },
    async fetchBlob(owner, repo, commit, path) {
      const response = await fetch(
        `${GITHUB_RAW_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commit}/${encodeRepoPath(path)}`,
        { headers: { "User-Agent": "opencompany-skills" } },
      );
      if (!response.ok) {
        throw new Error(`Couldn't read ${path} (${response.status}).`);
      }
      return response.text();
    },
  };
}

const OWNER_REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

// Parse a user-pasted source into a normalized GitHub reference. Accepts github.com repo and
// /tree/ urls, skills.sh skill-page urls, and `owner/repo[/subpath][@name][#ref]` shorthand.
// Throws SkillResolverError for anything else (non-allowlisted host, malformed, traversal).
export function parseSkillUrl(input: string): ParsedSkillUrl {
  const raw = input.trim();
  if (!raw) throw new SkillResolverError("Provide a GitHub or skills.sh URL.");

  if (/^https?:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new SkillResolverError("That doesn't look like a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new SkillResolverError("Only https URLs are supported.");
    }
    const host = parsed.hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") {
      return parseGitHubUrl(parsed);
    }
    if (host === "skills.sh" || host === "www.skills.sh") {
      return parseSkillsShUrl(parsed);
    }
    throw new SkillResolverError(
      "Only public github.com and skills.sh URLs are supported in this version.",
    );
  }

  return parseShorthand(raw);
}

function parseGitHubUrl(parsed: URL): ParsedSkillUrl {
  const ref = decodeHashRef(parsed.hash);
  const segments = pathSegments(parsed.pathname);
  const owner = segments[0];
  const repo = stripGitSuffix(segments[1] ?? "");
  if (!owner || !repo || !OWNER_REPO_SEGMENT.test(owner) || !OWNER_REPO_SEGMENT.test(repo)) {
    throw new SkillResolverError("Expected a github.com/<owner>/<repo> URL.");
  }
  const result: ParsedSkillUrl = {
    sourceType: "github",
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}`,
  };
  if (ref) result.ref = ref;

  // /owner/repo/tree/<ref>/<subpath...>
  if (segments[2] === "tree" && segments[3]) {
    result.ref = segments[3];
    const subpath = sanitizeSubpath(segments.slice(4).join("/"));
    if (subpath) result.subpath = subpath;
  }
  return result;
}

function parseSkillsShUrl(parsed: URL): ParsedSkillUrl {
  const segments = pathSegments(parsed.pathname);
  // https://www.skills.sh/<owner>/<repo>/<slug>
  const owner = segments[0];
  const repo = stripGitSuffix(segments[1] ?? "");
  const slug = segments[2];
  if (!owner || !repo || !OWNER_REPO_SEGMENT.test(owner) || !OWNER_REPO_SEGMENT.test(repo)) {
    throw new SkillResolverError("Expected a skills.sh/<owner>/<repo>/<skill> URL.");
  }
  const result: ParsedSkillUrl = {
    sourceType: "skills.sh",
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}`,
  };
  if (slug) result.nameFilter = slug;
  const ref = decodeHashRef(parsed.hash);
  if (ref) result.ref = ref;
  return result;
}

function parseShorthand(raw: string): ParsedSkillUrl {
  let working = raw;
  let ref: string | undefined;
  const hashIndex = working.indexOf("#");
  if (hashIndex !== -1) {
    ref = working.slice(hashIndex + 1).trim() || undefined;
    working = working.slice(0, hashIndex);
  }
  let nameFilter: string | undefined;
  const atIndex = working.indexOf("@");
  if (atIndex !== -1) {
    nameFilter = working.slice(atIndex + 1).trim() || undefined;
    working = working.slice(0, atIndex);
  }
  const segments = pathSegments(working);
  const owner = segments[0];
  const repo = stripGitSuffix(segments[1] ?? "");
  if (!owner || !repo || !OWNER_REPO_SEGMENT.test(owner) || !OWNER_REPO_SEGMENT.test(repo)) {
    throw new SkillResolverError("Expected `owner/repo` or a GitHub/skills.sh URL.");
  }
  const result: ParsedSkillUrl = {
    sourceType: "github",
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}`,
  };
  if (ref) result.ref = ref;
  if (nameFilter) result.nameFilter = nameFilter;
  const subpath = sanitizeSubpath(segments.slice(2).join("/"));
  if (subpath) result.subpath = subpath;
  return result;
}

function pathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function decodeHashRef(hash: string): string | undefined {
  const value = hash.replace(/^#/, "").trim();
  return value ? value : undefined;
}

function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/i, "");
}

function sanitizeSubpath(subpath: string): string {
  const normalized = subpath.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!normalized) return "";
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new SkillResolverError("Skill path may not contain '..'.");
  }
  return normalized;
}

// Turn a skill's SKILL.md `name` into a valid mount slug.
export function slugifySkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

// Ensure the slug is a valid mount id that doesn't collide with a built-in skill or an
// already-reserved id in the workspace. Appends a short integrity-derived suffix on collision.
export function ensureSkillMountId(slug: string, integrity: string, reserved: Set<string>): string {
  const suffix = integrity.replace(/^sha256:/, "").slice(0, 6);
  let base = isValidSkillMountId(slug) ? slug : `skill-${suffix}`;
  if (!isKnownAgentSkillId(base) && !reserved.has(base)) return base;
  const withSuffix = `${base.slice(0, 57)}-${suffix}`;
  base = isValidSkillMountId(withSuffix) ? withSuffix : `skill-${suffix}`;
  return base;
}

// Normalize a declared `command:` into a slash-token slug ([a-z0-9_]). A leading slash is
// tolerated (`/graphify` → `graphify`), internal spaces/hyphens become underscores
// (`deep-research` → `deep_research`), and anything that strips to empty yields null so callers
// can omit the field. Kept in sync with `toSlashSlug` (web) and the slash matcher (`/^\/(\w+)/`).
export function normalizeSkillCommand(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || null;
}

export function parseSkillFrontmatter(
  content: string,
): { name: string; description: string; command?: string } | null {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return null;
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(normalized.slice(4, end));
  } catch {
    return null;
  }
  if (!frontmatter || typeof frontmatter !== "object") return null;
  const record = frontmatter as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!name || !description) return null;
  const command = normalizeSkillCommand(record.command);
  return { name, description, ...(command ? { command } : {}) };
}

// Directories (relative to repo root) that contain a SKILL.md. "" = repository root.
export function discoverSkillDirectories(tree: SkillTreeEntry[], subpath?: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    if (!entry.path.endsWith("SKILL.md")) continue;
    const dir = entry.path === "SKILL.md" ? "" : entry.path.slice(0, -"/SKILL.md".length);
    if (subpath !== undefined && subpath !== "" && dir !== subpath) continue;
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  // Stable priority: root first, then shallower paths, then lexical.
  dirs.sort((a, b) => {
    const depthA = a === "" ? 0 : a.split("/").length;
    const depthB = b === "" ? 0 : b.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return dirs;
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function looksBinary(content: string): boolean {
  // A NUL byte never appears in valid UTF-8 text; the replacement char (U+FFFD) appears
  // when bytes failed to decode as UTF-8. Either means this isn't a text file.
  return content.includes("\u0000") || content.includes("\uFFFD");
}

// Validate the gathered files. Returns an error message or null.
export function validateSkillFiles(files: AgentSkillFile[]): string | null {
  if (files.length === 0) return "Skill has no files.";
  if (!files.some((file) => file.path === "SKILL.md")) {
    return "Skill is missing a SKILL.md at its root.";
  }
  if (files.length > SKILL_RESOLVER_LIMITS.maxFileCount) {
    return `Skill has too many files (max ${SKILL_RESOLVER_LIMITS.maxFileCount}).`;
  }
  let total = 0;
  for (const file of files) {
    if (file.path.split("/").some((segment) => segment === "..")) {
      return "Skill contains an unsafe file path.";
    }
    const bytes = new TextEncoder().encode(file.content).length;
    if (bytes > SKILL_RESOLVER_LIMITS.maxFileBytes) {
      return `Skill file ${file.path} is too large.`;
    }
    if (looksBinary(file.content)) {
      return `Skill file ${file.path} is not a text file.`;
    }
    total += bytes;
  }
  if (total > SKILL_RESOLVER_LIMITS.maxTotalBytes) {
    return `Skill is too large (max ${Math.floor(SKILL_RESOLVER_LIMITS.maxTotalBytes / 1024)} KB).`;
  }
  return null;
}

async function gatherSkillFiles(input: {
  tree: SkillTreeEntry[];
  dir: string;
  owner: string;
  repo: string;
  commit: string;
  fetcher: SkillResolverFetcher;
}): Promise<AgentSkillFile[]> {
  const { tree, dir, owner, repo, commit, fetcher } = input;
  const prefix = dir === "" ? "" : `${dir}/`;
  const blobs = tree.filter(
    (entry) => entry.type === "blob" && (dir === "" || entry.path.startsWith(prefix)),
  );
  // Reject symlinks outright (mode 120000) — they can point outside the skill folder.
  if (blobs.some((entry) => entry.mode === "120000")) {
    throw new SkillResolverError("Skill contains a symlink, which is not allowed.");
  }
  if (blobs.length > SKILL_RESOLVER_LIMITS.maxFileCount) {
    throw new SkillResolverError(
      `Skill has too many files (max ${SKILL_RESOLVER_LIMITS.maxFileCount}).`,
    );
  }
  const files: AgentSkillFile[] = [];
  for (const entry of blobs) {
    const relative = dir === "" ? entry.path : entry.path.slice(prefix.length);
    if (!relative || relative.includes("/.git/") || relative.startsWith(".git/")) continue;
    if (relative.split("/").includes("node_modules")) continue;
    const content = await fetcher.fetchBlob(owner, repo, commit, entry.path);
    files.push({ path: relative, content });
  }
  return files;
}

// Resolve a skill from a source url. Fetches via the injected fetcher (network), validates,
// hashes, and returns either a fully resolved skill or an ambiguous candidate list.
export async function resolveSkill(input: {
  url: string;
  fetcher: SkillResolverFetcher;
  // When the repo has multiple skills, the caller re-invokes with the chosen directory path.
  selectedPath?: string;
  // Mount ids already used in the workspace, so a new skill gets a non-colliding slug.
  reservedIds?: Set<string>;
}): Promise<ResolveSkillResult> {
  const parsed = parseSkillUrl(input.url);
  const reserved = input.reservedIds ?? new Set<string>();

  const ref = parsed.ref ?? (await input.fetcher.defaultBranch(parsed.owner, parsed.repo));
  const commit = await input.fetcher.resolveCommit(parsed.owner, parsed.repo, ref);
  if (!commit) {
    throw new SkillResolverError(
      "Couldn't read that repository. Check the URL — only public repositories are supported.",
    );
  }

  const tree = await input.fetcher.fetchTree(parsed.owner, parsed.repo, commit);
  let dirs = discoverSkillDirectories(tree, parsed.subpath);
  if (dirs.length === 0) {
    throw new SkillResolverError("No SKILL.md found in that repository or path.");
  }

  // For a skills.sh nameFilter, prefer a directory whose basename matches before reading
  // frontmatter for everything.
  if (parsed.nameFilter) {
    const byBasename = dirs.filter((dir) => basename(dir) === parsed.nameFilter);
    if (byBasename.length > 0) dirs = byBasename;
  }

  const chosenDir =
    input.selectedPath !== undefined
      ? dirs.find((dir) => dir === input.selectedPath)
      : dirs.length === 1
        ? dirs[0]
        : undefined;

  if (chosenDir === undefined) {
    // Build a candidate chooser by reading each SKILL.md's frontmatter (capped).
    const candidates: SkillCandidate[] = [];
    for (const dir of dirs.slice(0, SKILL_RESOLVER_LIMITS.maxCandidateReads)) {
      const mdPath = dir === "" ? "SKILL.md" : `${dir}/SKILL.md`;
      const md = await input.fetcher.fetchBlob(parsed.owner, parsed.repo, commit, mdPath);
      const frontmatter = parseSkillFrontmatter(md);
      if (!frontmatter) continue;
      if (parsed.nameFilter && slugifySkillName(frontmatter.name) !== parsed.nameFilter) continue;
      candidates.push({ path: dir, ...frontmatter });
    }
    if (candidates.length === 0) {
      throw new SkillResolverError("No valid SKILL.md (with name and description) was found.");
    }
    if (candidates.length === 1) {
      return finalizeSkill({
        ...input,
        parsed,
        ref,
        commit,
        tree,
        candidate: candidates[0]!,
        reserved,
      });
    }
    return {
      status: "ambiguous",
      candidates,
      source: { type: parsed.sourceType, url: parsed.url, ref },
      resolvedCommit: commit,
    };
  }

  const mdPath = chosenDir === "" ? "SKILL.md" : `${chosenDir}/SKILL.md`;
  const md = await input.fetcher.fetchBlob(parsed.owner, parsed.repo, commit, mdPath);
  const frontmatter = parseSkillFrontmatter(md);
  if (!frontmatter) {
    throw new SkillResolverError("SKILL.md is missing a valid `name` and `description`.");
  }
  return finalizeSkill({
    ...input,
    parsed,
    ref,
    commit,
    tree,
    candidate: { path: chosenDir, ...frontmatter },
    reserved,
  });
}

async function finalizeSkill(input: {
  parsed: ParsedSkillUrl;
  fetcher: SkillResolverFetcher;
  // The branch/ref already resolved by resolveSkill, threaded through so we don't re-fetch
  // defaultBranch and risk source.ref drifting from the commit we resolved against.
  ref: string;
  commit: string;
  tree: SkillTreeEntry[];
  candidate: SkillCandidate;
  reserved: Set<string>;
}): Promise<ResolveSkillResult> {
  const { parsed, ref, commit, tree, candidate, reserved, fetcher } = input;
  const files = await gatherSkillFiles({
    tree,
    dir: candidate.path,
    owner: parsed.owner,
    repo: parsed.repo,
    commit,
    fetcher,
  });
  const validationError = validateSkillFiles(files);
  if (validationError) throw new SkillResolverError(validationError);

  const integrity = await computeSkillFolderIntegrity(files);
  const skillId = ensureSkillMountId(slugifySkillName(candidate.name), integrity, reserved);
  const totalBytes = files.reduce(
    (sum, file) => sum + new TextEncoder().encode(file.content).length,
    0,
  );

  return {
    status: "resolved",
    skill: {
      skillId,
      name: candidate.name,
      description: candidate.description,
      ...(candidate.command ? { command: candidate.command } : {}),
      source: {
        type: parsed.sourceType,
        url: parsed.url,
        ref,
        path: candidate.path,
      },
      resolvedCommit: commit,
      integrity,
      files,
      fileCount: files.length,
      totalBytes,
    },
  };
}
