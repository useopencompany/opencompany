import { CoreError } from "@opencompany/core";
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
export const SentryFixSetupSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    baseBranch: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          !/[\s~^:?*\[\\]/.test(value) &&
          !value.includes("..") &&
          !value.startsWith("-") &&
          !value.endsWith("."),
        "Invalid branch name",
      ),
    engine: z.enum(["codex", "claude-code"]),
  })
  .strict();
export type SentryFixSetup = z.infer<typeof SentryFixSetupSchema>;
export const SENTRY_FIX_SETUP_PREFIX = "Sentry fix configuration: ";
export function sentryFixInstructions(instructions: string, setup: SentryFixSetup) {
  const value = SentryFixSetupSchema.parse(setup);
  return `${instructions}\n\n${SENTRY_FIX_SETUP_PREFIX}${JSON.stringify(value)}\nUse repository ${value.repository} and base branch ${value.baseBranch}. These are explicit values, do not infer a different repository or base branch.`;
}
export function readSentryFixSetup(instructions: string): SentryFixSetup | null {
  const line = instructions.split("\n").find((line) => line.startsWith(SENTRY_FIX_SETUP_PREFIX));
  if (!line) return null;
  return SentryFixSetupSchema.parse(JSON.parse(line.slice(SENTRY_FIX_SETUP_PREFIX.length)));
}
export async function validateSentryFixSetup(input: {
  userWorkosId: string;
  setup: SentryFixSetup;
  activation?: boolean;
}) {
  const setup = SentryFixSetupSchema.parse(input.setup);
  if (input.activation) {
    const connected =
      setup.engine === "codex"
        ? await isCodexConnectedForUser(input.userWorkosId)
        : await isClaudeCodeConnectedForUser(input.userWorkosId);
    if (!connected)
      throw new CoreError(
        "invalid_argument",
        `Connect ${setup.engine === "codex" ? "Codex" : "Claude Code"} before activating a Sentry fix workflow.`,
      );
  }
  const [owner, repo] = setup.repository.split("/");
  const access = await listGitHubUserRepositoryAccess({
    userWorkosId: input.userWorkosId,
    owner: owner!,
    repo: repo!,
  });
  const installation = access.installations.find(
    (installation) =>
      !installation.suspendedAt &&
      installation.repositories.some(
        (repository) => repository.fullName.toLowerCase() === setup.repository.toLowerCase(),
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
      "Grant the GitHub App Contents and Pull requests write access before using this fix workflow.",
    );
  const connection = await loadGitHubUserIntegration({ userWorkosId: input.userWorkosId });
  if (!connection || connection.status !== "connected")
    throw new CoreError(
      "invalid_argument",
      "Connect GitHub as you before using this fix workflow.",
    );
  const token = await getGitHubUserAccessToken({
    userWorkosId: input.userWorkosId,
    integrationId: connection.id,
  });
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(setup.baseBranch)}`,
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
  if (branch.name !== setup.baseBranch)
    throw new CoreError("invalid_argument", "GitHub returned a different branch.");
  return setup;
}
