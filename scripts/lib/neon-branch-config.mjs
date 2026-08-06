export const CLOUD_SANDBOX_PARENT_BRANCH = "cloud-base";

const MAX_NEON_BRANCH_NAME_LENGTH = 63;
const MAX_SANDBOX_ID_LENGTH = 32;

export function sanitizeNeonBranchName(name) {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NEON_BRANCH_NAME_LENGTH);

  if (!sanitized) {
    throw new Error(`Could not derive a valid Neon branch name from "${name}".`);
  }

  return sanitized;
}

export function resolveNeonBranchName({ gitBranch, branchNameOverride, sandboxId }) {
  if (branchNameOverride) return sanitizeNeonBranchName(branchNameOverride);

  const localBranchName = sanitizeNeonBranchName(gitBranch);
  if (!sandboxId?.trim()) return localBranchName;

  const sanitizedSandboxId = sanitizeNeonBranchName(sandboxId).slice(0, MAX_SANDBOX_ID_LENGTH);
  const suffix = `e2b-${sanitizedSandboxId}`;
  const maxLocalBranchLength = MAX_NEON_BRANCH_NAME_LENGTH - suffix.length - 1;
  const truncatedLocalBranchName = localBranchName
    .slice(0, maxLocalBranchLength)
    .replace(/-+$/g, "");

  return `${truncatedLocalBranchName}-${suffix}`;
}

export function resolveNeonParentBranch({ localParentBranch, sandboxId }) {
  if (sandboxId?.trim()) return CLOUD_SANDBOX_PARENT_BRANCH;
  return localParentBranch;
}
