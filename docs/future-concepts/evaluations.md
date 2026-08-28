# Product and agent evaluations

- Status: Proposed
- Original research: 2026-07-07
- Last reviewed: 2026-08-26

## Goal

Add repeatable evaluation suites for main Chat behavior, Workflow planning, and durable Task
execution without making production behavior depend on a third-party evaluation framework.

## Evaluation layers

### Main Chat behavior

Cases should assert tool choice, permission behavior, source use, answer quality, and durable side
effects for representative user requests. Fixtures need stable workspace state and deterministic
provider adapters so failures distinguish model behavior from external-service drift.

### Workflow planning

Planner cases should validate step decomposition, dependency ordering, selected Skills and Plugins,
confirmation boundaries, schedule semantics, and the immutable runtime versions captured by each
step.

### Task execution

Execution cases should validate admission, retries, terminal settlement, tool and approval events,
artifacts, and recovery after interruption. These checks should exercise the same application
services and runner paths used by production rather than a separate toy agent loop.

## Harness shape

A repository-owned case format should describe:

- initial workspace, Conversation, Brain, and integration fixtures;
- user input or Task/Workflow definition;
- engine and model policy;
- deterministic mocked provider responses where needed;
- assertions over semantic events, tool calls, durable records, artifacts, and final output; and
- optional rubric-based graders for qualities that cannot be expressed as exact assertions.

Deterministic assertions remain authoritative for safety and state transitions. Model graders may
score relevance, completeness, or style but should emit inspectable reasoning and never hide a
failed invariant.

## Relationship to external frameworks

Vercel eve is useful research for datasets, assertions, experiment runs, and result comparison, but
opencompany needs first-class fixtures for its durable protocol, database state, permission model,
and runner recovery. The initial harness should therefore be native and small. Adapters can export
results or use external optimization tools later.

DSPy may help optimize prompts after stable metrics and representative datasets exist. It should not
define the runtime architecture or substitute for product-level acceptance cases.

## Initial sequence

1. Define the case schema and runner around existing test infrastructure.
2. Land a small deterministic suite for permissions, tool selection, and durable settlement.
3. Add representative Chat, planner, and Task datasets from sanitized failure modes.
4. Add optional rubric graders with recorded model/version metadata.
5. Add experiment comparison and CI policy only after flake rate and cost are understood.

## Open decisions

- Which cases run on every pull request versus scheduled or manual evaluation runs.
- How sanitized production failures become durable regression fixtures.
- Budget, model pinning, and acceptable variance for grader-backed cases.
- Where evaluation artifacts and longitudinal results are retained.

The first implementation should prioritize a trustworthy regression signal over framework breadth.
