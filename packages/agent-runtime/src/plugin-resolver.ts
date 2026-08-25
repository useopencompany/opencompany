import { type ArtifactFile, computeArtifactIntegrity } from "./artifact-integrity";
import { PLUGIN_LIMITS, SKILL_LIMITS } from "./artifact-policy";
import {
  assertSafeRelativePath,
  executableBitForBlobMode,
  isSubmodule,
  PathSafetyError,
} from "./path-safety";
import {
  discoverPluginSkillDirectories,
  type McpConfigResult,
  type PluginManifest,
  PluginSpecError,
  parseMcpConfig,
  parsePluginManifest,
  type StdioMcpServer,
} from "./plugin-spec";
import {
  createGitHubSkillFetcher,
  parseSkillUrl,
  SkillResolverError,
  type SkillResolverFetcher,
  type SkillTreeEntry,
} from "./skill-resolver";
import { parseSkillDocument, SkillSpecError } from "./skill-spec";

export class PluginResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginResolverError";
  }
}

export type PluginSource = {
  type: "github" | "skills.sh";
  url: string;
  ref: string;
  path: string;
};

export type ResolvedPluginSkill = {
  path: string;
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  body: string;
  integrity: string;
  files: ArtifactFile[];
  fileCount: number;
  totalBytes: number;
};

export type PluginSkillValidationReport =
  | { path: string; name: string; status: "valid"; integrity: string }
  | { path: string; name: string; status: "skipped"; reason: string };

export type PluginMcpValidationReport =
  | { status: "absent" }
  | ({ status: "disabled"; reason: string } & { present: true })
  | ({ status: "parsed"; reports: Extract<McpConfigResult, { status: "parsed" }>["reports"] } & {
      present: true;
    });

export type PluginValidationReport = {
  ignoredManifestFields: string[];
  skills: PluginSkillValidationReport[];
  mcp: PluginMcpValidationReport;
};

export type ResolvedPlugin = {
  manifest: PluginManifest;
  source: PluginSource;
  resolvedCommit: string;
  integrity: string;
  files: ArtifactFile[];
  fileCount: number;
  totalBytes: number;
  skills: ResolvedPluginSkill[];
  stdioServers: StdioMcpServer[];
  report: PluginValidationReport;
};

export function createGitHubPluginFetcher(): SkillResolverFetcher {
  return createGitHubSkillFetcher();
}

export async function resolvePlugin(input: {
  url: string;
  fetcher: SkillResolverFetcher;
  selectedPath?: string;
}): Promise<ResolvedPlugin> {
  let parsed: ReturnType<typeof parseSkillUrl>;
  try {
    parsed = parseSkillUrl(input.url);
  } catch (error) {
    if (error instanceof SkillResolverError) throw new PluginResolverError(error.message);
    throw error;
  }

  const ref = parsed.ref ?? (await input.fetcher.defaultBranch(parsed.owner, parsed.repo));
  const commit = await input.fetcher.resolveCommit(parsed.owner, parsed.repo, ref);
  if (!commit) {
    throw new PluginResolverError(
      "Couldn't read that repository. Check the URL — only public repositories are supported.",
    );
  }
  const tree = await input.fetcher.fetchTree(parsed.owner, parsed.repo, commit);
  if (tree.truncated) {
    throw new PluginResolverError(
      "That repository's file tree is too large to read completely; link directly to the plugin directory.",
    );
  }

  const root = selectPluginRoot(tree.entries, input.selectedPath ?? parsed.subpath);
  const pluginJsonEntry = findRootFile(tree.entries, root, "plugin.json");
  if (!pluginJsonEntry) throw new PluginResolverError("Plugin is missing plugin.json at its root.");
  try {
    executableBitForBlobMode(pluginJsonEntry.mode);
  } catch (error) {
    throw new PluginResolverError(
      error instanceof Error ? error.message : "plugin.json has an unsafe file mode.",
    );
  }
  if ((pluginJsonEntry.size ?? 0) > PLUGIN_LIMITS.maxFileBytes) {
    throw new PluginResolverError("plugin.json is too large.");
  }
  assertPluginTreeDeclaredSizes(tree.entries, root);

  const pluginJson = await input.fetcher.fetchBlob(
    parsed.owner,
    parsed.repo,
    commit,
    pluginJsonEntry.path,
  );
  if (pluginJson.length > PLUGIN_LIMITS.maxFileBytes) {
    throw new PluginResolverError("plugin.json is too large.");
  }
  let manifestResult: ReturnType<typeof parsePluginManifest>;
  try {
    manifestResult = parsePluginManifest(decodeUtf8(pluginJson, "plugin.json"));
  } catch (error) {
    if (error instanceof PluginSpecError) throw new PluginResolverError(error.message);
    throw error;
  }

  const files = await gatherPluginFiles({
    entries: tree.entries,
    root,
    owner: parsed.owner,
    repo: parsed.repo,
    commit,
    fetcher: input.fetcher,
    prefetched: new Map([[pluginJsonEntry.path, pluginJson]]),
  });
  const relativeEntries = files.map((file) => ({ path: file.path, type: "blob" as const }));
  const skillDirectories = discoverPluginSkillDirectories(relativeEntries);
  const skills: ResolvedPluginSkill[] = [];
  const skillReports: PluginSkillValidationReport[] = [];
  for (const directory of skillDirectories) {
    const path = `skills/${directory}`;
    try {
      const skill = await resolvePluginSkill(files, directory);
      skills.push(skill);
      skillReports.push({ path, name: skill.name, status: "valid", integrity: skill.integrity });
    } catch (error) {
      skillReports.push({
        path,
        name: directory,
        status: "skipped",
        reason: error instanceof Error ? error.message : "Skill validation failed.",
      });
    }
  }

  const mcpFile = files.find((file) => file.path === "mcp.json");
  let stdioServers: StdioMcpServer[] = [];
  let mcpReport: PluginMcpValidationReport = { status: "absent" };
  if (mcpFile) {
    let parsedMcp: McpConfigResult;
    try {
      parsedMcp = parseMcpConfig(decodeUtf8(mcpFile.content, "mcp.json"));
    } catch (error) {
      parsedMcp = {
        status: "disabled",
        reason: error instanceof Error ? error.message : "mcp.json is not valid UTF-8 text.",
      };
    }
    if (parsedMcp.status === "disabled") {
      mcpReport = { present: true, status: "disabled", reason: parsedMcp.reason };
    } else {
      stdioServers = parsedMcp.servers;
      mcpReport = { present: true, status: "parsed", reports: parsedMcp.reports };
    }
  }

  const integrity = await computeArtifactIntegrity(files);
  const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
  return {
    manifest: manifestResult.manifest,
    source: { type: parsed.sourceType, url: parsed.url, ref, path: root },
    resolvedCommit: commit,
    integrity,
    files,
    fileCount: files.length,
    totalBytes,
    skills,
    stdioServers,
    report: {
      ignoredManifestFields: manifestResult.ignoredFields,
      skills: skillReports,
      mcp: mcpReport,
    },
  };
}

function selectPluginRoot(entries: SkillTreeEntry[], requestedRoot?: string) {
  if (requestedRoot !== undefined) {
    const root = normalizeRoot(requestedRoot);
    if (!findRootFile(entries, root, "plugin.json")) {
      throw new PluginResolverError("Plugin is missing plugin.json at the selected path.");
    }
    return root;
  }

  const roots = entries
    .filter((entry) => entry.type === "blob")
    .flatMap((entry) => {
      if (entry.path === "plugin.json") return [""];
      return entry.path.endsWith("/plugin.json")
        ? [entry.path.slice(0, -"/plugin.json".length)]
        : [];
    })
    .sort((left, right) => {
      if (left === "") return -1;
      if (right === "") return 1;
      return left.localeCompare(right);
    });
  if (roots.length === 0) throw new PluginResolverError("No plugin.json found in that repository.");
  if (roots[0] === "" || roots.length === 1) return roots[0]!;
  throw new PluginResolverError(
    "That repository contains multiple plugins. Link directly to one plugin directory.",
  );
}

function normalizeRoot(value: string) {
  const root = value.split("/").filter(Boolean).join("/");
  if (!root) return "";
  try {
    assertSafeRelativePath(root);
  } catch (error) {
    throw new PluginResolverError(
      error instanceof Error ? error.message : "The plugin path is invalid.",
    );
  }
  return root;
}

function findRootFile(entries: SkillTreeEntry[], root: string, name: string) {
  const path = root ? `${root}/${name}` : name;
  return entries.find((entry) => entry.path === path && entry.type === "blob");
}

function assertPluginTreeDeclaredSizes(entries: SkillTreeEntry[], root: string) {
  const prefix = root ? `${root}/` : "";
  const blobs = entries.filter(
    (entry) => entry.type === "blob" && (root === "" || entry.path.startsWith(prefix)),
  );
  if (blobs.some((entry) => (entry.size ?? 0) > PLUGIN_LIMITS.maxFileBytes)) {
    throw new PluginResolverError("Plugin contains a file larger than the 2 MB limit.");
  }
  const declaredTotalBytes = blobs.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (declaredTotalBytes > PLUGIN_LIMITS.maxTotalBytes) {
    throw new PluginResolverError("Plugin is too large (max 16 MB).");
  }
}

async function gatherPluginFiles(input: {
  entries: SkillTreeEntry[];
  root: string;
  owner: string;
  repo: string;
  commit: string;
  fetcher: SkillResolverFetcher;
  prefetched: Map<string, Uint8Array>;
}) {
  const prefix = input.root ? `${input.root}/` : "";
  const contained = input.entries.filter(
    (entry) => input.root === "" || entry.path.startsWith(prefix),
  );
  for (const entry of contained) {
    if (isSubmodule(entry.mode, entry.type)) {
      throw new PluginResolverError("Plugin contains a submodule, which is not allowed.");
    }
  }
  const blobs = contained.filter((entry) => entry.type === "blob");
  if (blobs.length > PLUGIN_LIMITS.maxFileCount) {
    throw new PluginResolverError(`Plugin has too many files (max ${PLUGIN_LIMITS.maxFileCount}).`);
  }

  const metadata = blobs.map((entry) => {
    const relative = input.root ? entry.path.slice(prefix.length) : entry.path;
    try {
      assertSafeRelativePath(relative);
      return { entry, relative, executable: executableBitForBlobMode(entry.mode) };
    } catch (error) {
      if (error instanceof PathSafetyError) throw new PluginResolverError(error.message);
      throw error;
    }
  });
  if (metadata.some(({ entry }) => (entry.size ?? 0) > PLUGIN_LIMITS.maxFileBytes)) {
    throw new PluginResolverError("Plugin contains a file larger than the 2 MB limit.");
  }

  const contents = await Promise.all(
    metadata.map(
      ({ entry }) =>
        input.prefetched.get(entry.path) ??
        input.fetcher.fetchBlob(input.owner, input.repo, input.commit, entry.path),
    ),
  );
  let totalBytes = 0;
  const files = metadata.map(({ relative, executable }, index) => {
    const content = contents[index]!;
    if (content.length > PLUGIN_LIMITS.maxFileBytes) {
      throw new PluginResolverError(`Plugin file ${relative} is too large.`);
    }
    totalBytes += content.length;
    return { path: relative, content, executable };
  });
  if (totalBytes > PLUGIN_LIMITS.maxTotalBytes) {
    throw new PluginResolverError("Plugin is too large (max 16 MB).");
  }
  return files;
}

async function resolvePluginSkill(files: ArtifactFile[], directory: string) {
  const prefix = `skills/${directory}/`;
  const skillFiles = files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
  if (skillFiles.length > SKILL_LIMITS.maxFileCount) {
    throw new PluginResolverError(`Skill has too many files (max ${SKILL_LIMITS.maxFileCount}).`);
  }
  const totalBytes = skillFiles.reduce((sum, file) => sum + file.content.length, 0);
  if (
    totalBytes > SKILL_LIMITS.maxTotalBytes ||
    skillFiles.some((file) => file.content.length > SKILL_LIMITS.maxFileBytes)
  ) {
    throw new PluginResolverError("Skill exceeds the Agent Skill size limits.");
  }
  const skillMarkdown = skillFiles.find((file) => file.path === "SKILL.md");
  if (!skillMarkdown) throw new PluginResolverError("Skill is missing SKILL.md at its root.");

  let document: ReturnType<typeof parseSkillDocument>;
  try {
    document = parseSkillDocument(decodeUtf8(skillMarkdown.content, "SKILL.md"), directory);
  } catch (error) {
    if (error instanceof SkillSpecError) throw new PluginResolverError(error.message);
    throw error;
  }
  const integrity = await computeArtifactIntegrity(skillFiles);
  const frontmatter = document.frontmatter;
  return {
    path: `skills/${directory}`,
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.license !== undefined ? { license: frontmatter.license } : {}),
    ...(frontmatter.compatibility !== undefined
      ? { compatibility: frontmatter.compatibility }
      : {}),
    ...(frontmatter.metadata !== undefined ? { metadata: frontmatter.metadata } : {}),
    ...(frontmatter.allowedTools !== undefined ? { allowedTools: frontmatter.allowedTools } : {}),
    body: document.body,
    integrity,
    files: skillFiles,
    fileCount: skillFiles.length,
    totalBytes,
  } satisfies ResolvedPluginSkill;
}

function decodeUtf8(bytes: Uint8Array, filename: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PluginResolverError(`${filename} is not valid UTF-8 text.`);
  }
}
