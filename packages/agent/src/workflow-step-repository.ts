import {
  CoreError,
  WORKFLOW_STEP_REPOSITORY_PATTERN,
  type WorkflowStepRepository,
  workflowStepBaseBranchValid,
} from "@opencompany/core";
import { z } from "zod";
import {
  isClaudeCodeConnectedForUser,
  isCodexConnectedForUser,
} from "./application/engine-auth-status";
import {
  getGitHubUserAccessToken,
  listGitHubUserRepositoryAccess,
  loadGitHubUserIntegration,
} from "./integrations/github-user";

const CODING_STEP_ENGINES = ["codex", "claude-code"] as const;

// Generated from the step's typed repository, so editing instructions cannot drop or change it.
export function workflowStepRepositoryInstructions(repository: WorkflowStepRepository) {
  return `Use repository ${repository.fullName} and base branch ${repository.baseBranch}. These are explicit values, do not infer a different repository or base branch.`;
}

// A step that names a repository must run on a coding engine that can push to it as the user.
// Activation also requires the chosen engine's account.
export async function validateWorkflowStepRepository(input: {
  userWorkosId: string;
  engine: string;
  repository: WorkflowStepRepository;
  activation?: boolean;
}) {
  const engine = CODING_STEP_ENGINES.find((candidate) => candidate === input.engine);
  if (!engine)
    throw new CoreError(
      "invalid_argument",
      "A step that works in a repository must use Codex or Claude Code.",
    );
  const { fullName, baseBranch } = input.repository;
  if (!WORKFLOW_STEP_REPOSITORY_PATTERN.test(fullName) || !workflowStepBaseBranchValid(baseBranch))
    throw new CoreError("invalid_argument", "Choose a valid repository and base branch.");
  if (input.activation) {
    const connected =
      engine === "codex"
        ? await isCodexConnectedForUser(input.userWorkosId)
        : await isClaudeCodeConnectedForUser(input.userWorkosId);
    if (!connected)
      throw new CoreError(
        "invalid_argument",
        `Connect ${engine === "codex" ? "Codex" : "Claude Code"} before activating a workflow that works in a repository.`,
      );
  }
  const [owner, repo] = fullName.split("/");
  const access = await listGitHubUserRepositoryAccess({
    userWorkosId: input.userWorkosId,
    owner: owner!,
    repo: repo!,
  });
  const installation = access.installations.find(
    (installation) =>
      !installation.suspendedAt &&
      installation.repositories.some(
        (repository) => repository.fullName.toLowerCase() === fullName.toLowerCase(),
      ),
  );
  if (!installation)
    throw new CoreError(
      "invalid_argument",
      "Your GitHub connection cannot access this repository.",
    );
  if (
    installation.permissions.contents !== "write" ||
    installation.permissions.pull_requests !== "write"
  )
    throw new CoreError(
      "invalid_argument",
      "Grant the GitHub App Contents and Pull requests write access before using this workflow.",
    );
  const connection = await loadGitHubUserIntegration({ userWorkosId: input.userWorkosId });
  if (!connection || connection.status !== "connected")
    throw new CoreError("invalid_argument", "Connect GitHub as you before using this workflow.");
  const token = await getGitHubUserAccessToken({
    userWorkosId: input.userWorkosId,
    integrationId: connection.id,
  });
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(baseBranch)}`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new CoreError(
      "invalid_argument",
      response.status === 404
        ? "The selected base branch does not exist or is inaccessible."
        : "GitHub could not verify the selected base branch.",
    );
  const branch = z.object({ name: z.string() }).parse(await response.json());
  if (branch.name !== baseBranch)
    throw new CoreError("invalid_argument", "GitHub returned a different branch.");
  return input.repository;
}
