// Client resource policy for imported Agent Skills and Agent Plugins.
//
// These caps are opencompany product policy, not part of either file format. The Agent Skills and
// Agent Plugins standards deliberately leave installation and resource limits to clients; this
// module is the single place those limits are declared so the resolver, plugin parser, and future
// storage/runner layers all enforce the same numbers.

const KIB = 1024;
const MIB = 1024 * 1024;

export type ArtifactSizeLimits = {
  // Maximum number of files in the artifact.
  maxFileCount: number;
  // Maximum total size, in bytes, across every file.
  maxTotalBytes: number;
  // Maximum size, in bytes, of any single file.
  maxFileBytes: number;
};

// Skill bundle: a small multi-file directory rooted at SKILL.md.
export const SKILL_LIMITS: ArtifactSizeLimits = {
  maxFileCount: 512,
  maxTotalBytes: 1 * MIB,
  maxFileBytes: 512 * KIB,
};

// Plugin package: a plugin.json root plus its skills/ components and optional mcp.json.
export const PLUGIN_LIMITS: ArtifactSizeLimits = {
  maxFileCount: 512,
  maxTotalBytes: 16 * MIB,
  maxFileBytes: 2 * MIB,
};

// Durable per-plugin PLUGIN_DATA archive. Only a total-size cap applies; the file count and
// per-file size are not policy-constrained for opaque runtime data.
export const PLUGIN_DATA_LIMITS = {
  maxTotalBytes: 32 * MIB,
} as const;
