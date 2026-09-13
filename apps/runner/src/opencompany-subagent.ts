/**
 * Subagent execution for the opencompany engine.
 *
 * The runner is the only composition root that can start a nested agent loop: it holds the model
 * credentials, the host tool runners, and the projector. A subagent run is a second
 * `runProductChatAgent` call with its own context window, a read-only slice of the parent's
 * runners, and its own step budget. Only the final summary crosses back into the parent's context.
 *
 * Live trace: each finished subagent step is projected into the parent's assistant message as
 * children of the subagent's tool part, the same nesting the ACP coding engines use for Claude
 * Code and Codex subagents. Because the parent's model stream is blocked while the tool executes,
 * the trace channel drives its own flushes rather than waiting for the next stream event.
 */

import {
  type ActionDispatcher,
  runProductChatAgent,
  type SkillDispatcher,
} from "@opencompany/agent/chat-agent";
import type { ChatActionCatalog } from "@opencompany/agent/chat-ui";
import {
  MAX_SUBAGENT_STEPS,
  type SubagentBudget,
  type SubagentRunner,
  type SubagentRunRequest,
  type SubagentToolOutput,
  truncateSubagentSummary,
} from "@opencompany/agent/subagent";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { LanguageModelUsage } from "ai";
import type { ProductChatUiPart } from "./opencompany-chat-projector";

/** Child tool input echoed into the trace. Enough to recognize the call, not the whole payload. */
const TRACE_INPUT_LIMIT = 1_000;
/** Child tool result preview, matching the ACP MCP tool-result budget. */
const TRACE_OUTPUT_LIMIT = 4_000;
/** Upper bound on trace rows per subagent, so a long run cannot bloat the persisted message. */
const MAX_TRACE_PARTS = 200;

export type SubagentTraceUpdate = {
  /** The subagent tool call whose `children` this replaces. May itself be a nested child. */
  parentToolCallId: string;
  children: ProductChatUiPart[];
};

export type SubagentTraceChannel = {
  publish: (update: SubagentTraceUpdate) => void;
  subscribe: (listener: (update: SubagentTraceUpdate) => void) => void;
};

export function createSubagentTraceChannel(): SubagentTraceChannel {
  let listener: ((update: SubagentTraceUpdate) => void) | null = null;
  return {
    publish: (update) => listener?.(update),
    subscribe: (next) => {
      // One channel belongs to one turn's projection. A second subscriber would silently replace
      // the first and drop its traces, so make that state impossible rather than debuggable.
      if (listener) throw new Error("A subagent trace channel accepts one subscriber per turn.");
      listener = next;
    },
  };
}

/**
 * Replace one subagent part's children, searching nested subagent parts too so a depth-2 run lands
 * under its own parent rather than the top-level one. Returns null when the id is not present.
 */
export function replaceSubagentChildren(
  parts: readonly ProductChatUiPart[],
  parentToolCallId: string,
  children: readonly ProductChatUiPart[],
): ProductChatUiPart[] | null {
  let changed = false;
  const next = parts.map((part) => {
    if (changed) return part;
    if (part.toolCallId === parentToolCallId) {
      changed = true;
      return { ...part, children: [...children] };
    }
    if (!Array.isArray(part.children)) return part;
    const nested = replaceSubagentChildren(
      part.children as ProductChatUiPart[],
      parentToolCallId,
      children,
    );
    if (!nested) return part;
    changed = true;
    return { ...part, children: nested };
  });
  return changed ? next : null;
}

/**
 * Narrow an action catalog to actions that execute without an approval prompt.
 *
 * A subagent has no surface to raise an approval on: the request would be written into a nested
 * turn nobody is watching, and the run would block until the turn timed out. Rather than
 * auto-approving on the user's behalf, "ask" actions are simply not in the subagent's catalog.
 */
export function autoApprovedActionCatalog(catalog: ChatActionCatalog): ChatActionCatalog {
  const actions = catalog.actions.filter((action) => action.permissionMode === "on");
  const sourcesWithActions = new Set(actions.map((action) => action.source));
  return {
    sources: catalog.sources.filter((source) => sourcesWithActions.has(source.id)),
    actions,
  };
}

export function createSubagentActionDispatcher(parent: ActionDispatcher): ActionDispatcher {
  const catalog = autoApprovedActionCatalog(parent.catalog);
  const allowedActionIds = new Set(catalog.actions.map((action) => action.id));
  return {
    ...parent,
    catalog,
    // The catalog is the model's menu, but a guessed id would otherwise still reach the parent
    // dispatcher and raise an approval nobody can answer. Refuse it here instead.
    execute: async (executeInput) => {
      if (!allowedActionIds.has(executeInput.action)) {
        return {
          ok: false,
          action: executeInput.action,
          error: {
            code: "not_permitted",
            message: `${executeInput.action} needs the user's approval, which a subagent cannot request. Report what should be done and let the main agent run it.`,
          },
        };
      }
      return parent.execute(executeInput);
    },
    needsApproval: async () => false,
  };
}

type SubagentToolContextRunners = {
  runBrainCli?: Parameters<typeof runProductChatAgent>[0]["runBrainCli"];
  runWiki?: Parameters<typeof runProductChatAgent>[0]["runWiki"];
  webSearch?: Parameters<typeof runProductChatAgent>[0]["webSearch"];
  webFetch?: Parameters<typeof runProductChatAgent>[0]["webFetch"];
  actions?: ActionDispatcher;
  skills?: SkillDispatcher;
};

export function createSubagentRunner(input: {
  model: AgentModelId;
  gatewayApiKey: string;
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string | null;
  brainRef?: string | null;
  currentDate: Date;
  signal: AbortSignal;
  budget: SubagentBudget;
  trace: SubagentTraceChannel;
  /** Bills the nested run against the same turn. Each call must get a unique step index. */
  recordUsage: (usage: LanguageModelUsage) => Promise<void>;
  runners: SubagentToolContextRunners;
}): SubagentRunner {
  const runSubagent: SubagentRunner = async (request: SubagentRunRequest) => {
    const children: ProductChatUiPart[] = [];
    let stepsTaken = 0;
    const publish = () => {
      input.trace.publish({
        parentToolCallId: request.toolCallId,
        children: [...children],
      });
    };
    const appendChild = (part: ProductChatUiPart) => {
      if (children.length > MAX_TRACE_PARTS) return;
      // Say that the trace stopped rather than letting later steps vanish from a still-running
      // subagent. The run itself continues; only its displayed trace is capped.
      if (children.length === MAX_TRACE_PARTS) {
        children.push({
          type: "text",
          text: `[Trace truncated after ${MAX_TRACE_PARTS} steps. The subagent is still working and its summary will be complete.]`,
          state: "done",
        });
        return;
      }
      children.push(part);
    };

    try {
      const result = await runProductChatAgent({
        messages: [{ role: "user", content: request.task }],
        model: input.model,
        gatewayApiKey: input.gatewayApiKey,
        workspaceId: input.workspaceId,
        userWorkosId: input.userWorkosId,
        chatSessionId: input.chatSessionId,
        currentDate: input.currentDate,
        abortSignal: input.signal,
        maxSteps: MAX_SUBAGENT_STEPS,
        subagent: { depth: request.depth },
        subagentBudget: input.budget,
        subagentDepth: request.depth,
        // Depth is what stops the recursion: `subagentToolSet` drops the tool once the child is at
        // MAX_SUBAGENT_DEPTH, so handing the runner down is safe at every level.
        runSubagent,
        wikiToolReadOnly: true,
        ...(input.brainRef ? { brainRef: input.brainRef } : {}),
        ...(input.runners.runBrainCli ? { runBrainCli: input.runners.runBrainCli } : {}),
        ...(input.runners.runWiki ? { runWiki: input.runners.runWiki } : {}),
        ...(input.runners.webSearch ? { webSearch: input.runners.webSearch } : {}),
        ...(input.runners.webFetch ? { webFetch: input.runners.webFetch } : {}),
        ...(input.runners.actions
          ? { actions: createSubagentActionDispatcher(input.runners.actions) }
          : {}),
        ...(input.runners.skills ? { skills: input.runners.skills } : {}),
        onStepFinish: async (step) => {
          stepsTaken += 1;
          for (const part of traceParts(step)) appendChild(part);
          publish();
          const usage = stepUsage(step);
          if (usage) await input.recordUsage(usage);
        },
      });

      const { summary, truncated } = truncateSubagentSummary(result.content);
      if (!summary) {
        return {
          ok: false,
          error: "The subagent finished without returning a summary.",
        };
      }
      return {
        ok: true,
        summary,
        steps: stepsTaken,
        ...(truncated ? { truncated: true } : {}),
      };
    } catch (error) {
      // An interrupted turn is already tearing the parent stream down; reporting it as a subagent
      // result would let the main agent keep generating against a dead lease.
      if (input.signal.aborted) throw error;
      // Any other subagent failure is reported, not thrown: the main agent can work around a
      // missing summary, but it cannot recover from the turn dying underneath it.
      return { ok: false, error: subagentErrorMessage(error) };
    } finally {
      publish();
    }
  };

  return runSubagent;
}

/** Project one finished model step into the tool and text rows the UI nests under the subagent. */
function traceParts(step: unknown): ProductChatUiPart[] {
  if (!isRecord(step)) return [];
  const parts: ProductChatUiPart[] = [];
  const text = typeof step.text === "string" ? step.text.trim() : "";
  if (text) parts.push({ type: "text", text, state: "done" });

  const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
  const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
  const resultsByCallId = new Map<string, Record<string, unknown>>();
  for (const result of toolResults) {
    if (!isRecord(result)) continue;
    const id = typeof result.toolCallId === "string" ? result.toolCallId : null;
    if (id) resultsByCallId.set(id, result);
  }

  for (const call of toolCalls) {
    if (!isRecord(call)) continue;
    const toolCallId = typeof call.toolCallId === "string" ? call.toolCallId : null;
    const toolName = typeof call.toolName === "string" ? call.toolName : null;
    if (!toolCallId || !toolName) continue;
    const result = resultsByCallId.get(toolCallId);
    // A call with no matching result was cut short by an abort or an error, so it stays in flight
    // rather than being shown as a completed step.
    parts.push({
      type: `tool-${toolName}`,
      toolCallId,
      state: result ? "output-available" : "input-available",
      input: previewValue(call.input, TRACE_INPUT_LIMIT),
      ...(result ? { output: previewValue(result.output, TRACE_OUTPUT_LIMIT) } : {}),
    });
  }
  return parts;
}

/**
 * Shrink a tool payload to a trace-sized preview. Objects keep their shape where they fit, so the
 * UI's existing tool rows can still read a query or a path out of the input.
 */
function previewValue(value: unknown, limit: number): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return truncateText(value, limit);
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
  if (serialized.length <= limit) return value;
  return truncateText(serialized, limit);
}

function truncateText(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [truncated]`;
}

function stepUsage(step: unknown): LanguageModelUsage | null {
  if (!isRecord(step) || !isRecord(step.usage)) return null;
  const usage = step.usage;
  const hasTokens =
    typeof usage.inputTokens === "number" ||
    typeof usage.outputTokens === "number" ||
    typeof usage.totalTokens === "number";
  return hasTokens ? (usage as unknown as LanguageModelUsage) : null;
}

function subagentErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return truncateText(`The subagent failed: ${message}`, 600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
