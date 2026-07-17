import type { CatalogService } from "../code-tool-interface/catalog-service";
import type { BenchmarkTask } from "../code-tool-interface/types";
import type { ProgressiveSandboxResult } from "./types";

export function evaluateProgressiveTask(input: {
  task: BenchmarkTask;
  catalog: CatalogService;
  sandboxAttempts: ProgressiveSandboxResult[];
  finalText: string;
}) {
  const failures: string[] = [];
  const invoked = input.catalog.trace.filter(
    (event) => event.kind === "invoke" || event.kind === "invoke_error",
  );
  const paths = invoked.map((event) => event.path).filter((path): path is string => Boolean(path));
  if (!input.finalText.trim()) failures.push("missing final assistant response");
  if (paths.length < input.task.minToolCalls) {
    failures.push(`expected >=${input.task.minToolCalls} catalog calls, received ${paths.length}`);
  }
  for (const required of input.task.requiredTools) {
    if (!paths.includes(required)) failures.push(`missing required tool ${required}`);
  }
  for (const group of input.task.anyOfTools ?? []) {
    if (!group.some((path) => paths.includes(path))) {
      failures.push(`missing one of: ${group.join(", ")}`);
    }
  }

  const described = new Set(
    input.catalog.trace
      .filter((event) => event.kind === "describe")
      .map((event) => event.path)
      .filter((path): path is string => Boolean(path)),
  );
  const invokedWithoutLoad = [...new Set(paths.filter((path) => !described.has(path)))];
  if (invokedWithoutLoad.length > 0) {
    failures.push(`invoked without progressive load: ${invokedWithoutLoad.join(", ")}`);
  }

  if (input.task.id === "fault-recover-tool-error") {
    const expectedReason =
      "GitHub rejected the merge: branch protection requires the security-review check.";
    const mergeError = input.catalog.trace.find(
      (event) =>
        event.kind === "invoke_error" &&
        event.path === "github.merge_pull_request" &&
        event.errorKind === "tool_error",
    );
    const slackText = input.catalog.mutations
      .filter((mutation) => mutation.path === "slack.send_message")
      .map((mutation) => stringifyCompact(mutation.input))
      .join(" ");
    if (mergeError?.error !== expectedReason) {
      failures.push("did not reach the seeded GitHub branch-protection rejection");
    }
    if (!slackText.includes(expectedReason)) {
      failures.push("Slack message omitted the exact seeded rejection reason");
    }
  }
  return failures;
}

function stringifyCompact(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}
