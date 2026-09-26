import {
  archiveHeadlessWorkflow,
  createHeadlessWorkflow,
  listHeadlessWorkflowCatalog,
  updateHeadlessWorkflow,
} from "@/lib/headless-automation-commands";

// The two workflows a technical founder starts with. Both are manual: the founder runs them from
// any chat as #build and #review-pr (the handle is the slug of the name), so they never act on
// their own. They name the repository onboarding scanned, so the first run needs no setup.

export type StarterWorkflow = {
  handle: "build" | "review-pr";
  name: string;
  description: string;
  instructions: (repository: string) => string;
};

export const STARTER_WORKFLOWS: readonly StarterWorkflow[] = [
  {
    handle: "build",
    name: "Build",
    description: "Describe a change. It writes the code and opens a pull request.",
    instructions: (
      repository,
    ) => `Implement the change the user asked for in the GitHub repository ${repository}, then open a pull request.

1. Read the repository's agent and contributor guides (AGENTS.md, CLAUDE.md, CONTRIBUTING.md) when they exist, and the code the change touches.
2. If the request is ambiguous in a way that changes the result, ask one short question. Otherwise make a sensible choice and note it in the pull request.
3. Work on a new branch and keep the change focused on the request.
4. Run the repository's own checks that apply to the change (tests, lint, typecheck) and fix failures you introduced.
5. Open a pull request against the default branch. Its description says what changed, why, and how it was verified.
6. Never merge, force-push, or change repository settings.

Reply with the pull request link and a two-line summary.`,
  },
  {
    handle: "review-pr",
    name: "Review PR",
    description: "Point it at a pull request. It reviews the diff and comments on GitHub.",
    instructions: (
      repository,
    ) => `Review a pull request in the GitHub repository ${repository} and leave the review on GitHub.

1. Use the pull request the user points to, by link or number. If none is given, use the most recently updated open pull request the user authored.
2. Read the description and the full diff, and open the surrounding code wherever the diff alone is not enough.
3. Look for correctness bugs, missing or weak tests, security issues, and changes that contradict the repository's guides. Skip style nits unless they hide a bug.
4. Leave one GitHub review of type "comment": inline comments on specific lines, most severe first, each saying what is wrong and what to do instead.
5. Never approve, merge, or push commits.

Reply with the review link and the most important finding.`,
  },
];

// Idempotent by name, so finishing onboarding twice never duplicates them. Creation is two calls
// (the API creates an empty draft and fills it on update); a failed update archives the draft so a
// nameless workflow is never left behind.
export async function createStarterWorkflows(repository: string) {
  const existing = new Set(
    (await listHeadlessWorkflowCatalog()).map((workflow) => workflow.name.toLowerCase()),
  );
  for (const starter of STARTER_WORKFLOWS) {
    if (existing.has(starter.name.toLowerCase())) continue;
    const workflow = await createHeadlessWorkflow({
      name: starter.name,
      description: starter.description,
      scope: "company",
    });
    try {
      await updateHeadlessWorkflow(workflow.id, {
        expectedVersion: workflow.version,
        name: starter.name,
        description: starter.description,
        steps: [
          {
            id: workflow.steps[0]?.id ?? globalThis.crypto.randomUUID(),
            title: starter.name,
            model: "",
            instructions: starter.instructions(repository),
          },
        ],
        status: "active",
        trigger: { type: "manual" },
        triggers: [],
      });
    } catch (cause) {
      await archiveHeadlessWorkflow(workflow.id, { expectedVersion: workflow.version }).catch(
        (archiveError: unknown) => {
          console.error(
            "[opencompany] Failed to clean up a half-created starter workflow",
            archiveError,
          );
        },
      );
      throw cause;
    }
  }
}
