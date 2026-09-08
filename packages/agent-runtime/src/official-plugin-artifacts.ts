import { computeArtifactIntegrity } from "./artifact-integrity";
import { OFFICIAL_PLUGIN_ARTIFACTS } from "./official-plugin-artifacts/index";
import { OFFICIAL_PLUGIN_SOURCES } from "./official-plugin-catalog";
import { PluginResolverError } from "./plugin-resolver";
import { parseSkillUrl, SkillResolverError, type SkillResolverFetcher } from "./skill-resolver";

/** Only exact reviewed package pins use release artifacts; all other sources use GitHub. */
export async function createOfficialPluginFetcher(input: {
  url: string;
  selectedPath?: string;
}): Promise<SkillResolverFetcher | null> {
  let parsed: ReturnType<typeof parseSkillUrl>;
  try {
    parsed = parseSkillUrl(input.url);
  } catch (error) {
    if (error instanceof SkillResolverError) throw new PluginResolverError(error.message);
    throw error;
  }
  const root = (input.selectedPath ?? parsed.subpath ?? "").split("/").filter(Boolean).join("/");
  const match = Object.entries(OFFICIAL_PLUGIN_SOURCES).find(([, source]) => {
    const pin = parseSkillUrl(source);
    return (
      parsed.owner.toLowerCase() === pin.owner &&
      parsed.repo.toLowerCase() === pin.repo &&
      parsed.ref?.toLowerCase() === pin.ref &&
      root === pin.subpath
    );
  });
  if (!match) return null;

  const [name, source] = match;
  const artifact = OFFICIAL_PLUGIN_ARTIFACTS[name as keyof typeof OFFICIAL_PLUGIN_ARTIFACTS];
  // A broken release must fail closed, never reintroduce a runtime GitHub dependency.
  if (
    !artifact ||
    artifact.source !== source ||
    artifact.resolvedCommit !== parsed.ref?.toLowerCase()
  ) {
    throw new Error(`Official plugin ${name} artifact does not match its catalog pin.`);
  }
  const files = artifact.files.map((file) => ({
    path: file.path,
    executable: file.executable,
    content: new Uint8Array(Buffer.from(file.contentBase64, "base64")),
  }));
  if ((await computeArtifactIntegrity(files)) !== artifact.integrity) {
    throw new Error(`Official plugin ${name} artifact integrity mismatch.`);
  }
  const entries = files.map((file) => ({
    path: `${root}/${file.path}`,
    type: "blob" as const,
    mode: file.executable ? "100755" : "100644",
    size: file.content.length,
  }));
  const blobs = new Map(entries.map((entry, index) => [entry.path, files[index]!.content]));
  return {
    async defaultBranch() {
      throw new Error("Official plugins require a commit pin.");
    },
    async resolveCommit() {
      return artifact.resolvedCommit;
    },
    async fetchTree() {
      return { entries, truncated: false };
    },
    async fetchBlob(_owner, _repo, _commit, path) {
      const content = blobs.get(path);
      if (!content) throw new Error(`Official plugin ${name} is missing a packaged file.`);
      return content;
    },
  };
}
