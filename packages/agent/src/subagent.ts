/**
 * Subagents for the opencompany engine.
 *
 * A subagent is one nested agent loop with its own context window. The parent delegates a
 * self-contained task, the subagent works it with a read-only slice of the parent's tools, and
 * only its final written summary crosses back. Every intermediate tool result — a 200-page wiki
 * sweep, forty search hits, a raw Linear payload — stays in the child's context and never enters
 * the parent's.
 *
 * This module owns the contract and the policy: the tool shape, the inherited tool set, and the
 * per-turn budget. Execution lives in the runner, which is the only composition root that can
 * build a nested tool context.
 */

import { PUBLISH_ARTIFACT_TOOL_NAME, WRITE_ARTIFACT_TOOL_NAME } from "@opencompany/agent-runtime";
import { BROWSER_TOOL_NAMES } from "@opencompany/browser-tools";
import { WIKI_TOOL_NAME } from "@opencompany/wiki/tool";
import {
  BRAIN_TOOL_NAME,
  BROWSER_USE_PROFILE_TOOL_NAME,
  CREATE_WORKSPACE_SKILL_TOOL_NAME,
  DELETE_TASK_SCHEDULE_TOOL_NAME,
  DESCRIBE_ACTIONS_TOOL_NAME,
  EDIT_TASK_SCHEDULE_TOOL_NAME,
  EDIT_WORKSPACE_SKILL_TOOL_NAME,
  LIST_ACTIONS_TOOL_NAME,
  LIST_SKILLS_TOOL_NAME,
  READ_SKILL_FILE_TOOL_NAME,
  SAVE_TO_BRAIN_TOOL_NAME,
  SCHEDULE_TASK_TOOL_NAME,
  START_TASK_TOOL_NAME,
  START_WORKFLOW_TOOL_NAME,
  USE_ACTION_TOOL_NAME,
  USE_SKILL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "./chat-ui";
import { WORKSPACE_SKILLS_TOOL_NAME } from "./workspace-skill-tools";

// Caps are calibrated against what shipping harnesses allow, so delegation is not artificially
// worse here than in Claude Code, Codex, or pi. The binding limit is the shared per-turn run
// budget: it bounds the whole tree regardless of how the model fans out or nests.
//
// Claude Code: 20 concurrent, 3 nesting levels, no per-turn cap, `maxTurns` opt-in.
// Codex: `max_concurrent_threads_per_session`, no documented per-turn cap.
// pi: 8 tasks per call, 4 concurrent, 50 KB output per task.

/** Total subagent runs one chat turn may start, counting nested runs. */
export const MAX_SUBAGENT_RUNS_PER_TURN = 16;

/** Subagent runs executing at once. Further runs queue rather than fail. */
export const MAX_CONCURRENT_SUBAGENTS = 8;

/**
 * Model steps one subagent may take. Deliberately larger than the parent's `CHAT_MAX_STEPS`: the
 * reason to delegate is that the child can afford depth the parent cannot.
 */
export const MAX_SUBAGENT_STEPS = 24;

/** Nesting levels below the main conversation. Depth 1 is a subagent of the main agent. */
export const MAX_SUBAGENT_DEPTH = 2;

/** Upper bound on the summary handed back to the parent, matching pi's 50 KB per-task cap. */
export const MAX_SUBAGENT_SUMMARY_CHARS = 50_000;

export const SUBAGENT_TOOL_NAME = "run_subagent";

export const SUBAGENT_TOOL_DESCRIPTION = [
  "Delegate a self-contained piece of work to a subagent that runs in its own context window and returns only a written summary.",
  "",
  "Use it when the work needs far more reading than its answer is worth keeping: sweeping the wiki, researching several things on the web, pulling records out of a connected integration. The intermediate results stay in the subagent's context, so yours keeps room for the actual conversation. Independent pieces of work should be separate calls issued in the same step — they run concurrently.",
  "",
  "The subagent starts fresh. It cannot see this conversation, so `task` has to stand on its own: the goal, the context it needs, and the exact shape of the answer you want back. It cannot ask you a follow-up question.",
  "",
  "A subagent is read-only. It can search the web, read the Wiki and Brain, read Skills, and call integration actions that run without approval. It cannot write, publish, save, start tasks or workflows, or call anything that needs the user's approval. When the work needs one of those, have the subagent report exactly what to do and then do it yourself.",
].join("\n");

export const SUBAGENT_TOOL_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: {
      type: "string",
      description:
        'Three to six words naming the work, shown to the user while the subagent runs. For example "researching pricing pages".',
      minLength: 1,
      maxLength: 80,
    },
    task: {
      type: "string",
      description:
        "The complete instruction for the subagent. It sees nothing but this, so include the goal, the context it needs, and what to return. Ask for the specifics you will need afterwards — identifiers, paths, URLs, quotes — not just a conclusion.",
      minLength: 1,
    },
  },
  required: ["description", "task"],
} as const;

export type SubagentToolInput = {
  description: string;
  task: string;
};

export type SubagentToolOutput =
  | {
      ok: true;
      summary: string;
      steps: number;
      /** Set when the summary hit `MAX_SUBAGENT_SUMMARY_CHARS` and was cut. */
      truncated?: boolean;
    }
  | { ok: false; error: string };

export type SubagentRunRequest = {
  description: string;
  task: string;
  /** The parent tool call this run belongs to; the UI nests the child's trace under it. */
  toolCallId: string;
  /** 1 for a subagent of the main agent, 2 for a subagent of a subagent. */
  depth: number;
};

export type SubagentRunner = (request: SubagentRunRequest) => Promise<SubagentToolOutput>;

export const SUBAGENT_SYSTEM_PROMPT = [
  "You are a subagent inside opencompany. The main agent delegated one piece of work to you and is waiting on the result.",
  "",
  "You run in your own context window. You cannot see the conversation that led here, and you cannot ask a follow-up question — nobody reads your intermediate steps. The written summary you end with is the only thing that reaches the main agent, so it has to carry everything worth knowing.",
  "",
  "- Work the task to completion with the tools you have, then write the answer.",
  "- You are writing for another agent, not a person. No greetings, no offers to help, no restating the task. Lead with the finding.",
  "- Carry the specifics across: exact identifiers, file paths, wiki page paths, URLs, dates, numbers, and short direct quotes. The agent reading you has not seen anything you read and must be able to act without redoing your work.",
  "- Say plainly what you could not determine, and what you looked at before giving up. A confident guess is worse than a stated gap.",
  "- You are read-only. You cannot write, publish, save, schedule, or start anything, and you have no access to actions that need the user's approval. If the task needs one of those, report exactly what should happen and where, and leave it to the main agent.",
].join("\n");

/**
 * Tools a subagent inherits from its parent. Read-only, and none of them can raise an approval
 * request: an approval has no surface to appear on inside a nested run, so an approving tool would
 * either hang the turn or be silently auto-denied. `use_action` is inherited but the runner hands
 * the child a catalog filtered to actions that execute without approval.
 *
 * Inheritance is default-deny. A tool added to the parent is withheld until someone classifies it,
 * and `subagent.test.ts` fails on any parent tool missing from both lists, so the decision cannot
 * be skipped by accident.
 */
export const SUBAGENT_INHERITED_TOOL_NAMES: readonly string[] = [
  BRAIN_TOOL_NAME,
  WIKI_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  LIST_ACTIONS_TOOL_NAME,
  DESCRIBE_ACTIONS_TOOL_NAME,
  USE_ACTION_TOOL_NAME,
  LIST_SKILLS_TOOL_NAME,
  USE_SKILL_TOOL_NAME,
  READ_SKILL_FILE_TOOL_NAME,
];

/** Parent tools deliberately withheld, with the reason grouped by line. */
export const SUBAGENT_WITHHELD_TOOL_NAMES: readonly string[] = [
  // Writes and publishes. A subagent reports what to change; the main agent changes it.
  SAVE_TO_BRAIN_TOOL_NAME,
  WRITE_ARTIFACT_TOOL_NAME,
  PUBLISH_ARTIFACT_TOOL_NAME,
  CREATE_WORKSPACE_SKILL_TOOL_NAME,
  EDIT_WORKSPACE_SKILL_TOOL_NAME,
  WORKSPACE_SKILLS_TOOL_NAME,
  // Spawning and scheduling durable work, which would escape the turn that authorized it.
  START_TASK_TOOL_NAME,
  START_WORKFLOW_TOOL_NAME,
  SCHEDULE_TASK_TOOL_NAME,
  EDIT_TASK_SCHEDULE_TOOL_NAME,
  DELETE_TASK_SCHEDULE_TOOL_NAME,
  // Reports the status of the parent task run, which is not the subagent's to report. Spelled out
  // because it is declared in chat-agent.ts, which imports this module.
  "update_task_status",
  // Browser sandboxes are stateful, expensive, and scoped to one turn's session.
  BROWSER_USE_PROFILE_TOOL_NAME,
  ...BROWSER_TOOL_NAMES,
  // Nesting is allowed up to MAX_SUBAGENT_DEPTH, so this one is added back by depth, not by name.
  SUBAGENT_TOOL_NAME,
];

/**
 * Narrow a parent tool set to what a subagent at `depth` may use.
 *
 * The subagent tool itself comes back only while there is depth left, which is what stops an
 * unbounded spawn tree independently of the run budget.
 */
export function subagentToolSet<TTool>(
  parentTools: Record<string, TTool>,
  options: { depth: number },
): Record<string, TTool> {
  const inherited = new Set(SUBAGENT_INHERITED_TOOL_NAMES);
  const canNest = options.depth < MAX_SUBAGENT_DEPTH;
  const tools: Record<string, TTool> = {};
  for (const [name, definition] of Object.entries(parentTools)) {
    if (inherited.has(name) || (canNest && name === SUBAGENT_TOOL_NAME)) tools[name] = definition;
  }
  return tools;
}

export function truncateSubagentSummary(summary: string): {
  summary: string;
  truncated: boolean;
} {
  const trimmed = summary.trim();
  if (trimmed.length <= MAX_SUBAGENT_SUMMARY_CHARS) return { summary: trimmed, truncated: false };
  return {
    summary: `${trimmed.slice(0, MAX_SUBAGENT_SUMMARY_CHARS)}\n\n[Truncated: the subagent returned more than ${MAX_SUBAGENT_SUMMARY_CHARS} characters. Delegate a narrower task if you need the rest.]`,
    truncated: true,
  };
}

export type SubagentBudgetLease = { ok: true; release: () => void } | { ok: false; error: string };

/**
 * Per-turn run budget and concurrency gate, shared by every level of the subagent tree.
 *
 * One budget instance is created per chat turn and threaded into nested tool contexts, so a
 * subagent that spawns its own subagents draws from the same 16 runs as the main agent. Runs over
 * the concurrency limit queue instead of failing, matching how shipping harnesses handle a wide
 * fan-out.
 */
export function createSubagentBudget(
  options: { maxRunsPerTurn?: number; maxConcurrent?: number; signal?: AbortSignal } = {},
) {
  const maxRuns = options.maxRunsPerTurn ?? MAX_SUBAGENT_RUNS_PER_TURN;
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_SUBAGENTS;
  let runsStarted = 0;
  let active = 0;
  // Each waiter carries its own settled flag so the queue is correct on its own terms. An abort
  // settles a waiter in place without removing it, and handing a freed slot to one of those would
  // strand a run that is still genuinely waiting. Today's single turn-scoped signal settles every
  // waiter at once so that cannot happen, but the queue should not depend on the caller for it.
  const waiting: Array<{ settled: boolean; grant: () => void }> = [];

  const releaseOne = () => {
    active -= 1;
    while (waiting.length > 0) {
      const next = waiting.shift();
      if (next && !next.settled) {
        next.grant();
        return;
      }
    }
  };

  return {
    runsStarted: () => runsStarted,
    async acquire(): Promise<SubagentBudgetLease> {
      if (runsStarted >= maxRuns) {
        return {
          ok: false,
          error: `This turn already used its budget of ${maxRuns} subagent runs. Finish with what you have, or start a task for work that needs more.`,
        };
      }
      runsStarted += 1;
      if (active >= maxConcurrent) {
        const granted = await new Promise<"granted" | "aborted">((resolve) => {
          if (options.signal?.aborted) {
            resolve("aborted");
            return;
          }
          const waiter = {
            settled: false,
            grant: () => {
              waiter.settled = true;
              resolve("granted");
            },
          };
          waiting.push(waiter);
          options.signal?.addEventListener(
            "abort",
            () => {
              if (waiter.settled) return;
              waiter.settled = true;
              resolve("aborted");
            },
            { once: true },
          );
        });
        if (granted === "aborted") {
          return { ok: false, error: "The turn was interrupted before this subagent could start." };
        }
      }
      active += 1;
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          releaseOne();
        },
      };
    },
  };
}

export type SubagentBudget = ReturnType<typeof createSubagentBudget>;

/** Behavior lines added to the main chat system prompt when the subagent tool is available. */
export const SUBAGENT_BEHAVIOR_LINES: readonly string[] = [
  `Delegate a self-contained piece of work to a subagent with ${SUBAGENT_TOOL_NAME} when the reading it takes dwarfs the answer it produces — a wide sweep of the Wiki, research across several sources, pulling a set of records out of an integration. The subagent works in its own context window and returns only a written summary, so the raw material never lands in this conversation.`,
  "Issue independent pieces of work as separate subagent calls in the same step; they run concurrently. Do the work yourself when it is one or two lookups, when you need to see the raw material, or when it needs a write or an approval.",
  "A subagent sees nothing but the task you write. State the goal, the context it needs, and what to hand back, including the identifiers, paths, URLs, or quotes you will need afterwards. It cannot ask you a follow-up question.",
  "Subagents are read-only and cannot use anything that needs the user's approval. When delegated work turns out to need a write, the subagent reports what should happen and you do it.",
];
