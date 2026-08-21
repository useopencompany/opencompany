import { type ArtifactFile, computeArtifactIntegrity } from "./artifact-integrity";
import { SKILL_LIMITS } from "./artifact-policy";
import {
  assertSafeRelativePath,
  executableBitForBlobMode,
  isSubmodule,
  PathSafetyError,
} from "./path-safety";
import { parseSkillDocument, type SkillFrontmatter, SkillSpecError } from "./skill-spec";
import type { AgentRemoteSkillSource } from "./types";

// Cap on how many candidate SKILL.md files we'll read to build a chooser, so a repo with hundreds
// of skills can't fan out into hundreds of blob requests.
const MAX_CANDIDATE_READS = 25;

export class SkillResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillResolverError";
  }
}

export type ParsedSkillUrl = {
  sourceType: AgentRemoteSkillSource["type"];
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
// "commit" entries are Git submodules; they are retained here so the resolver can reject a skill
// that contains one rather than silently dropping it.
export type SkillTreeEntry = {
  path: string;
  type: "blob" | "tree" | "commit";
  // Git mode string. "120000" is a symlink and "160000" is a submodule; both are rejected.
  mode: string;
  size?: number;
};

// Result of reading a repository tree. `truncated` mirrors the GitHub tree API flag: when the tree
// is too large the API returns a partial listing, which we must reject rather than treat as complete.
export type SkillTree = {
  entries: SkillTreeEntry[];
  truncated: boolean;
};

// Network boundary. Callers supply concrete implementations (unauthenticated GitHub requests to
// api.github.com / raw.githubusercontent.com only). Keeping it injected makes the resolver pure and
// unit-testable, and keeps the SSRF surface in one small place. Blobs are returned as raw bytes;
// only SKILL.md is UTF-8 decoded, and only by the resolver.
export type SkillResolverFetcher = {
  defaultBranch(owner: string, repo: string): Promise<string>;
  // Returns the 40-hex commit sha for a ref, or null if the ref/repo can't be read.
  resolveCommit(owner: string, repo: string, ref: string): Promise<string | null>;
  fetchTree(owner: string, repo: string, commit: string): Promise<SkillTree>;
  fetchBlob(owner: string, repo: string, commit: string, path: string): Promise<Uint8Array>;
};

export type SkillCandidate = {
  // Skill directory path within the repo, "" = repository root.
  path: string;
  name: string;
  description: string;
};

export type ResolvedSkill = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  // The model-facing SKILL.md body (everything after the frontmatter), decoded from SKILL.md.
  body: string;
  source: AgentRemoteSkillSource;
  resolvedCommit: string;
  integrity: string;
  files: ArtifactFile[];
  fileCount: number;
  totalBytes: number;
};

export type ResolveSkillResult =
  | { status: "resolved"; skill: ResolvedSkill }
  // More than one skill in the repo and the caller didn't pick one: present these.
  | {
      status: "ambiguous";
      candidates: SkillCandidate[];
      source: Pick<AgentRemoteSkillSource, "type" | "url" | "ref">;
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

// Unauthenticated GitHub fetcher for public repositories (V1). A private repo or bad URL reads as
// 404 and surfaces as a clean "couldn't read that repository" error.
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
        truncated?: boolean;
        tree?: Array<{ path?: string; type?: string; mode?: string; size?: number }>;
      };
      const rawEntries = Array.isArray(json.tree) ? json.tree : [];
      const entries = rawEntries.flatMap<SkillTreeEntry>((entry) => {
        if (typeof entry.path !== "string" || typeof entry.mode !== "string") return [];
        if (entry.type !== "blob" && entry.type !== "tree" && entry.type !== "commit") return [];
        return [
          {
            path: entry.path,
            type: entry.type,
            mode: entry.mode,
            ...(typeof entry.size === "number" ? { size: entry.size } : {}),
          },
        ];
      });
      return { entries, truncated: json.truncated === true };
    },
    async fetchBlob(owner, repo, commit, path) {
      const response = await fetch(
        `${GITHUB_RAW_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commit}/${encodeRepoPath(path)}`,
        { headers: { "User-Agent": "opencompany-skills" } },
      );
      if (!response.ok) {
        throw new Error(`Couldn't read ${path} (${response.status}).`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

const OWNER_REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

// Parse a user-pasted source into a normalized GitHub reference. Accepts github.com repo and /tree/
// urls, skills.sh skill-page urls, and `owner/repo[/subpath][@name][#ref]` shorthand. Throws
// SkillResolverError for anything else (non-allowlisted host, malformed, traversal).
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

// Directories (relative to repo root) that contain a SKILL.md. "" = repository root.
export function discoverSkillDirectories(entries: SkillTreeEntry[], subpath?: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
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

// The directory name a skill at `dir` must match. A subdirectory skill matches its own basename; a
// repository-root skill (`dir === ""`) matches the repository name, which is the checkout directory.
function expectedNameForDir(dir: string, repo: string): string {
  return dir === "" ? repo : basename(dir);
}

function decodeSkillMarkdown(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SkillResolverError("SKILL.md is not valid UTF-8 text.");
  }
}

// Gather every file under `dir` as raw bytes plus its executable bit, enforcing path- and
// mode-safety and the skill size limits. Rejects symlinks, submodules, `.git`, traversal, and
// oversize packages.
async function gatherSkillFiles(input: {
  entries: SkillTreeEntry[];
  dir: string;
  owner: string;
  repo: string;
  commit: string;
  fetcher: SkillResolverFetcher;
}): Promise<ArtifactFile[]> {
  const { entries, dir, owner, repo, commit, fetcher } = input;
  const prefix = dir === "" ? "" : `${dir}/`;
  const contained = entries.filter((entry) => dir === "" || entry.path.startsWith(prefix));

  // Reject a submodule anywhere in the skill folder before fetching anything.
  for (const entry of contained) {
    if (isSubmodule(entry.mode, entry.type)) {
      throw new SkillResolverError("Skill contains a submodule, which is not allowed.");
    }
  }

  const blobs = contained.filter((entry) => entry.type === "blob");
  if (blobs.length > SKILL_LIMITS.maxFileCount) {
    throw new SkillResolverError(`Skill has too many files (max ${SKILL_LIMITS.maxFileCount}).`);
  }

  const files: ArtifactFile[] = [];
  let totalBytes = 0;
  for (const entry of blobs) {
    const relative = dir === "" ? entry.path : entry.path.slice(prefix.length);
    let executable: boolean;
    try {
      assertSafeRelativePath(relative);
      executable = executableBitForBlobMode(entry.mode);
    } catch (error) {
      if (error instanceof PathSafetyError) throw new SkillResolverError(error.message);
      throw error;
    }
    const content = await fetcher.fetchBlob(owner, repo, commit, entry.path);
    if (content.length > SKILL_LIMITS.maxFileBytes) {
      throw new SkillResolverError(`Skill file ${relative} is too large.`);
    }
    totalBytes += content.length;
    if (totalBytes > SKILL_LIMITS.maxTotalBytes) {
      throw new SkillResolverError(
        `Skill is too large (max ${Math.floor(SKILL_LIMITS.maxTotalBytes / 1024)} KB).`,
      );
    }
    files.push({ path: relative, content, executable });
  }

  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new SkillResolverError("Skill is missing a SKILL.md at its root.");
  }
  return files;
}

// Resolve a skill from a source url. Fetches via the injected fetcher (network), validates against
// the strict Agent Skills spec, hashes, and returns either a fully resolved skill or an ambiguous
// candidate list.
export async function resolveSkill(input: {
  url: string;
  fetcher: SkillResolverFetcher;
  // When the repo has multiple skills, the caller re-invokes with the chosen directory path.
  selectedPath?: string;
}): Promise<ResolveSkillResult> {
  const parsed = parseSkillUrl(input.url);

  const ref = parsed.ref ?? (await input.fetcher.defaultBranch(parsed.owner, parsed.repo));
  const commit = await input.fetcher.resolveCommit(parsed.owner, parsed.repo, ref);
  if (!commit) {
    throw new SkillResolverError(
      "Couldn't read that repository. Check the URL — only public repositories are supported.",
    );
  }

  const tree = await input.fetcher.fetchTree(parsed.owner, parsed.repo, commit);
  if (tree.truncated) {
    throw new SkillResolverError(
      "That repository's file tree is too large to read completely; import a specific skill subdirectory instead.",
    );
  }
  const entries = tree.entries;

  let dirs = discoverSkillDirectories(entries, parsed.subpath);
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
    // Build a candidate chooser by reading each SKILL.md's frontmatter (capped). Skills that fail
    // strict validation are skipped rather than surfaced.
    const candidates: SkillCandidate[] = [];
    for (const dir of dirs.slice(0, MAX_CANDIDATE_READS)) {
      const mdPath = dir === "" ? "SKILL.md" : `${dir}/SKILL.md`;
      const bytes = await input.fetcher.fetchBlob(parsed.owner, parsed.repo, commit, mdPath);
      let frontmatter: SkillFrontmatter;
      try {
        frontmatter = parseSkillDocument(
          decodeSkillMarkdown(bytes),
          expectedNameForDir(dir, parsed.repo),
        ).frontmatter;
      } catch (error) {
        if (error instanceof SkillSpecError || error instanceof SkillResolverError) continue;
        throw error;
      }
      if (parsed.nameFilter && frontmatter.name !== parsed.nameFilter) continue;
      candidates.push({ path: dir, name: frontmatter.name, description: frontmatter.description });
    }
    if (candidates.length === 0) {
      throw new SkillResolverError("No valid SKILL.md (with name and description) was found.");
    }
    if (candidates.length === 1) {
      return finalizeSkill({
        parsed,
        ref,
        commit,
        entries,
        dir: candidates[0]!.path,
        fetcher: input.fetcher,
      });
    }
    return {
      status: "ambiguous",
      candidates,
      source: { type: parsed.sourceType, url: parsed.url, ref },
      resolvedCommit: commit,
    };
  }

  return finalizeSkill({ parsed, ref, commit, entries, dir: chosenDir, fetcher: input.fetcher });
}

async function finalizeSkill(input: {
  parsed: ParsedSkillUrl;
  // The branch/ref already resolved by resolveSkill, threaded through so we don't re-fetch
  // defaultBranch and risk source.ref drifting from the commit we resolved against.
  ref: string;
  commit: string;
  entries: SkillTreeEntry[];
  dir: string;
  fetcher: SkillResolverFetcher;
}): Promise<ResolveSkillResult> {
  const { parsed, ref, commit, entries, dir, fetcher } = input;
  const files = await gatherSkillFiles({
    entries,
    dir,
    owner: parsed.owner,
    repo: parsed.repo,
    commit,
    fetcher,
  });

  const skillMarkdown = files.find((file) => file.path === "SKILL.md");
  if (!skillMarkdown) {
    throw new SkillResolverError("Skill is missing a SKILL.md at its root.");
  }
  let document: ReturnType<typeof parseSkillDocument>;
  try {
    document = parseSkillDocument(
      decodeSkillMarkdown(skillMarkdown.content),
      expectedNameForDir(dir, parsed.repo),
    );
  } catch (error) {
    if (error instanceof SkillSpecError) throw new SkillResolverError(error.message);
    throw error;
  }

  const integrity = await computeArtifactIntegrity(files);
  const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
  const { frontmatter } = document;

  return {
    status: "resolved",
    skill: {
      name: frontmatter.name,
      description: frontmatter.description,
      ...(frontmatter.license !== undefined ? { license: frontmatter.license } : {}),
      ...(frontmatter.compatibility !== undefined
        ? { compatibility: frontmatter.compatibility }
        : {}),
      ...(frontmatter.metadata !== undefined ? { metadata: frontmatter.metadata } : {}),
      ...(frontmatter.allowedTools !== undefined ? { allowedTools: frontmatter.allowedTools } : {}),
      body: document.body,
      source: {
        type: parsed.sourceType,
        url: parsed.url,
        ref,
        path: dir,
      },
      resolvedCommit: commit,
      integrity,
      files,
      fileCount: files.length,
      totalBytes,
    },
  };
}
