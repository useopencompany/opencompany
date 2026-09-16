import type { HarnessNormalizedEvent } from "@opencompany/agent-runtime";
import {
  findPullRequestRefs,
  isPullRequestCreationTool,
  type PullRequestRef,
} from "@opencompany/core";

/**
 * Recognises the pull requests a coding-agent turn opened, from the events the turn already emits.
 *
 * Only the two acts that *create* a PR count: the hosted GitHub MCP `create_pull_request` tool, and
 * `gh pr create` in the sandbox. Assistant prose is deliberately not scanned — an agent citing
 * someone else's PR for reference is common, and a URL in prose cannot be told apart from one the
 * agent just opened. Narrowing to creation is what makes a linked PR trustworthy without having to
 * second-guess it later.
 */
export function createPullRequestCaptureScanner() {
  // `gh pr create` prints its URL as the last line of stdout, but output arrives as deltas that can
  // split mid-URL. Keep a bounded tail per command so a URL spanning two deltas is still matched.
  const commandOutputTails = new Map<string, string>();

  return {
    /** The PRs this event shows being created. Empty for the overwhelming majority of events. */
    scan(event: HarnessNormalizedEvent): PullRequestRef[] {
      if (event.type === "mcp_tool.completed") {
        if (event.payload.status !== "completed") return [];
        const tool = readString(event.payload.tool) ?? readString(event.payload.toolName);
        if (!isPullRequestCreationTool(tool)) return [];
        // The tool result is JSON carrying `html_url`; scanning its text finds that without
        // having to depend on the hosted server's exact response shape.
        const result = readString(event.payload.result);
        return result ? findPullRequestRefs(result) : [];
      }

      if (event.type === "command.output") {
        const itemId = readString(event.payload.itemId);
        const delta = readString(event.payload.delta);
        if (!itemId || !delta || !isPullRequestCreationCommand(readString(event.payload.command)))
          return [];
        const scanned = `${commandOutputTails.get(itemId) ?? ""}${delta}`;
        commandOutputTails.set(itemId, scanned.slice(-COMMAND_TAIL_LIMIT));
        return findPullRequestRefs(scanned);
      }

      if (event.type === "command.completed" || event.type === "command.failed") {
        const itemId = readString(event.payload.itemId);
        if (itemId) commandOutputTails.delete(itemId);
      }
      return [];
    },
  };
}

// Long enough to hold any PR URL plus the surrounding line, short enough that a chatty command
// cannot grow this map into a memory problem over a long turn.
const COMMAND_TAIL_LIMIT = 300;

// `gh pr create` opens a PR; `gh pr list`, `gh pr view`, and `gh pr checks` all print PR URLs
// without opening anything, so the subcommand pair has to match exactly.
const PULL_REQUEST_CREATE_COMMAND = /(?:^|\s|\/)gh\s+(?:[^|;&]*\s)?pr\s+create(?:\s|$)/;

function isPullRequestCreationCommand(command: string | null) {
  return command ? PULL_REQUEST_CREATE_COMMAND.test(command) : false;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
