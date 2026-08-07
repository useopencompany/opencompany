# Goat Evaluation Research

Status: research note for future implementation.

This document captures the current understanding of Vercel eve evals, how that pattern maps to
Goat, and where DSPy-style optimization could fit later.

## Summary

Goat should start with a custom evaluation harness, not a direct adoption of Vercel eve.

The useful idea from eve is not the framework dependency. The useful idea is the shape of the test:
drive the agent with a realistic user message, let the real system run, capture the messages, tool
calls, task events, and final output, then assert that the behavior matched the product contract.

For Goat, this should become a small suite of behavior evals across the main chat agent, the task
harness planner, and the background task executor. If we later want automatic prompt optimization,
DSPy can use a subset of those evals as the scoring function for bounded subproblems.

## What Vercel eve Evals Do

Vercel eve evals are file-based checks for an eve agent. An eval sends one or more messages to the
agent through the same session interface users hit, waits for the run to settle, then checks what the
agent did.

Typical assertions include:

- the run completed
- the run parked for human approval when expected
- a specific tool was called
- a dangerous or irrelevant tool was not called
- tools appeared in the expected order
- the final reply included required text
- a structured output matched a schema
- an LLM judge scored a free-form answer above a threshold

The important part is that these are behavior tests for a non-deterministic system. They usually do
not require an exact final response. They check durable contracts around tool use, routing, safety,
output shape, and task completion.

Reference sources:

- Vercel eve docs: `https://vercel.com/docs/eve`
- Vercel eve launch post: `https://vercel.com/blog/introducing-eve`
- eve eval overview: `https://raw.githubusercontent.com/vercel/eve/main/docs/evals/overview.mdx`
- eve eval assertions: `https://raw.githubusercontent.com/vercel/eve/main/docs/evals/assertions.mdx`
- eve eval running guide: `https://raw.githubusercontent.com/vercel/eve/main/docs/evals/running.mdx`

## Why Not Use eve Directly

Goat is already its own durable agent/task system:

- `apps/goat` owns the product UI and task creation flow.
- `apps/runner` owns task planning, execution, tool lifecycle, usage recording, and result writes.
- Postgres is the source of task state.
- Electric collections stream task state into the UI.
- The runner already emits structured task, message, and tool events.

eve evals expect an eve project and the eve `/eve/v1/session` protocol. Using `eve eval` directly
would require either moving Goat behind eve's runtime model or writing an adapter that mimics that
protocol. That is too much coupling for the value we need right now.

Instead, Goat should copy the eval pattern and build a native runner that understands Goat's own
task events and product contracts.

## Recommended Goat Eval Layers

### 1. Main Goat chat behavior

The main chat agent should be evaluated with realistic user prompts and assertions over the chat
result plus side effects.

Examples:

- A user asks for a quick answer that can be answered inline: no durable task should be spawned.
- A user asks for work that needs long-running tools or connected account access: a task should be
  spawned.
- A user asks for web research: the web/search path should be used in the right place.
- A user asks for private Gmail or Calendar context: the answer should route to the task/tool path
  only when the relevant integration is available.
- A user asks for a saved report: the flow should create or reference a task/result artifact rather
  than burying the deliverable only in chat text.

This layer protects the product boundary between conversational answers and durable task execution.

### 2. Harness planner behavior

The planner should be evaluated independently because it is a compact, high-leverage decision point.
It turns a user task into a `goat.harness.v1` spec: model, system prompt, initial user message,
tools, skills, max steps, and result mode.

Examples:

- Deep market research selects `resultMode: "brain_markdown_report"`.
- Quick summaries use `resultMode: "assistant_final"`.
- Gmail tasks select Gmail tools when available.
- Calendar tasks select Calendar tools when available.
- Linear read tasks select Linear MCP tools.
- Linear write/update tasks select Linear MCP only when the user explicitly asks for a mutation.
- GitHub repo tasks include `github_clone_repository` before follow-up GitHub tools.
- GitHub PR creation includes `github_open_pull_request` only when the user explicitly asked to
  publish, push, or open a pull request.
- Hard strategy or prioritization tasks select `first-principles` or `yc-office-hours` only when the
  skill materially improves the task.

This layer is the best first target for evals because the output is structured and cheap to score.

### 3. Task execution behavior

The background task executor should be evaluated against controlled tool fixtures and the emitted
task event stream.

Examples:

- The task calls the expected tool family for the job.
- The task does not call write-capable tools without explicit user intent.
- The task records tool start/completion/failure events correctly.
- The task emits a final assistant message.
- A report-mode task creates a Brain Markdown report artifact.
- A GitHub task performs clone, shell/status, and optional PR in a sensible order.
- A failed tool run is surfaced as failure or uncertainty rather than silently hidden.

This layer tests whether the model actually follows the harness, not just whether the planner
produced a good harness.

## Shape of a Goat-Native Eval Harness

A future implementation can be small. It does not need to be a general external framework.

The likely core pieces:

- `defineGoatEval(...)` or a Vitest-compatible helper for declaring eval cases.
- An in-memory `GoatTaskRunSink` that records messages, events, tool calls, usage, and artifacts.
- Fixture tools for deterministic tool outputs.
- Optional live-tool evals for a slower, opt-in suite.
- Hard gates for product contracts.
- Soft scores for quality signals.
- JSON and JUnit output for CI.
- Stored artifacts for failed runs, including the prompt, planned harness, event stream, tool calls,
  and final reply.

Pseudo-shape:

```ts
goatEval("github inspection does not publish without explicit permission", async (t) => {
  await t.runTask("Inspect opencompany/repo and summarize what changed.");

  t.succeeded();
  t.calledTool("github_clone_repository");
  t.calledTool("github_status");
  t.notCalledTool("github_open_pull_request");
  t.replyIncludes("diff");
});
```

## Where DSPy Fits

DSPy should be treated as an optimizer, not the first eval framework.

The eval harness defines what "good" means. DSPy can later search for better prompts,
instructions, or few-shot examples that improve scores on a training subset. Humans still need to
choose the metric, review the generated prompt, and confirm it generalizes beyond the training set.

Good DSPy targets for Goat:

- harness planner prompt optimization
- tool-selection and result-mode classification
- model-selection rules
- small routing decisions in the main chat agent
- judge prompts, if we introduce LLM-as-judge scoring
- output-format prompts for reports or final answers

Poor first DSPy targets:

- the entire long-running Goat task loop
- live connected-account workflows with side effects
- sandbox-heavy GitHub tasks
- anything where the metric is unclear or mostly subjective

The practical sequence should be:

1. Build deterministic Goat-native evals.
2. Add enough representative cases to catch regressions.
3. Split train/dev sets only when we have a stable scoring function.
4. Use DSPy for bounded subproblems.
5. Promote optimized prompts only after they pass the held-out eval set and human review.

## Initial Eval Case Ideas

Main chat:

- "What is Goat?" should answer inline and not spawn a task.
- "Research the top five competitors in this market and save the result" should spawn a durable
  task.
- "Look at my latest Gmail threads about pricing" should require Gmail availability and route to a
  task/tool path.
- "Can you browse the web and summarize current pricing for X?" should use web/search behavior.

Planner:

- Deep research prompt selects `brain_markdown_report`.
- Quick summarization prompt selects `assistant_final`.
- GitHub inspect prompt excludes PR creation.
- GitHub publish prompt includes PR creation.
- Startup strategy prompt may select `yc-office-hours`.
- Hard prioritization prompt may select `first-principles`.

Executor:

- GitHub inspect task calls clone and status but not PR.
- GitHub publish task calls clone, shell/status, and PR.
- Gmail summary task calls Gmail search/thread tools.
- Calendar availability task calls Calendar freebusy/list tools.
- Report-mode task produces an artifact event.

## Open Questions

- Should evals live under `apps/runner/evals`, `apps/goat/evals`, or a shared
  `packages/goat-evals` package?
- Should the first version run inside Vitest or as a separate CLI?
- Which evals should be deterministic and always run in CI?
- Which evals should be live, slower, and manually triggered?
- What is the smallest safe fixture layer for Gmail, Calendar, Linear, GitHub, and web search?
- Should Braintrust be used only for traces, or also as the experiment/reporting destination for
  eval results?

## Recommendation

Start with a small custom Goat eval harness focused on hard behavioral gates. The first milestone
should cover the harness planner and a handful of main-chat routing cases. Add executor/tool-path
evals once we have stable fixtures.

Do not start by adopting eve directly. Do not start with DSPy optimization. Build the measurement
layer first, then use DSPy selectively once the metrics are stable enough to optimize against.
