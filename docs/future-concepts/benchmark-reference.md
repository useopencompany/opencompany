# Benchmark reference — grading real work

- Status: Reference for harness-bench v2 scenario design
- Research date: 2026-09-12 (web research against primary sources + prod workload analysis)
- Feeds: [Harness bench](./harness-bench.md) "Sequencing after v1" · north star in
  [Product and agent evaluations](./evaluations.md)

Harness bench v1 grades narrow scenarios deterministically. This document is the field survey
for the next step: ambitious cases close to real work, where "done" is harder to define. It
answers two questions from the benchmarks the field already trusts: **what do realistic tasks
look like**, and **how is completion verified** — so our first real-work case copies proven
grading mechanics instead of inventing them.

## The benchmarks that matter

Grouped by what they grade. Each entry: example task shape, then the grading mechanics.

### Real deliverables, graded against humans

**GDPval** (OpenAI, 2025-09, [openai.com/index/gdpval](https://openai.com/index/gdpval/),
[arXiv:2510.04374](https://arxiv.org/pdf/2510.04374)). 1,320 tasks across 44 occupations,
written by professionals averaging 14 years of experience; ~7h of expert work per task. The
model gets a request plus reference files (spreadsheets, decks, CAD, audio) and must produce
the actual file deliverable — e.g. a legal brief, a financial model as `.xlsx`, a sales deck as
`.pptx`. Grading: **blind pairwise comparison by occupational experts** against the human
expert's deliverable (win/tie/loss; ~1h per comparison, 70.8% human inter-rater agreement),
plus a trained automated pairwise grader at 65.7% agreement that powers cheap reruns. Best at
launch: Claude Opus 4.1, 47.6% win-or-tie. Most-cited lesson: the #1 expert rejection reason
was **instruction-following, not knowledge**, and one-shot prompt→deliverable (no clarifying
questions) is the acknowledged unrealism.

**Remote Labor Index** (Scale AI + CAIS, 2025-10, [scale.com/research/rli](https://scale.com/research/rli)).
240 real, previously-paid Upwork projects (median $200, 11.5 human-hours). Agent gets the real
client brief + files; trained evaluators judge whether the deliverable would meet the paying
client's bar vs the accepted human deliverable. Metrics: **automation rate and dollars
earned** (best agent: 2.5%/$1,720 at launch, ~16% by mid-2026). Failure taxonomy is the
actionable output: ~46% quality shortfalls, ~36% incomplete/malformed deliverables, ~18%
broken files — the bottleneck is finishing and packaging, not reasoning.

**Mercor APEX-Agents** (2026-01, [mercor.com/apex](https://www.mercor.com/apex/)). 31 simulated
firm "worlds" (Workspace + dataroom file systems, deliberately messy and incomplete), 240 tasks
like the deliverables of a week-long consulting engagement. Grading: **1–10 expert-written
binary pass/fail criteria per task** ("client-ready" checklist authored by VPs/MDs), judge-
executed with expert audit. Frontier models <25% single-attempt. Failures dominated by
ambiguity management and file discovery across the messy dataroom, not domain knowledge.

**DeepResearch Bench** (2025-06, [arXiv:2506.11763](https://arxiv.org/pdf/2506.11763)). 100
PhD-level research tasks. The two-sided grading pattern for long-form research reports:
**RACE** (LLM judge on adaptive task-specific weighted criteria: comprehensiveness, insight,
instruction-following, readability — calibrated against human preference) + **FACT**
(programmatic citation extraction and URL verification: effective citation count and accuracy).

### Simulated workplaces, graded by end state

**TheAgentCompany** (CMU, 2024-12, [arXiv:2412.14161](https://arxiv.org/abs/2412.14161)).
175 tasks inside a self-hosted fake software company: GitLab, OwnCloud (files), Plane
(sprints), RocketChat, plus LLM-played colleagues the agent must message. Example finance
task (8 pts): fill IRS Form 6765 Section B correctly (5 pts) and message the right finance
director for a missing figure (3 pts). Grading: **ordered checkpoints with point values**,
each verified by deterministic code (file exists, DB state, correct chat message) or an LLM
judge for free-form text; score `0.5·(points/total) + 0.5·full_completion`. Best models ~30%
full completion at ~$4.20/task. Documented failure modes worth designing against: social
incompetence in chat, and **deceptive shortcuts** (an agent renamed a user to fake having
found the right colleague) — checkpoint verifiers must check outcomes, not surface signals.

**τ-bench / τ²-bench** (Sierra, 2024–2025, [arXiv:2406.12045](https://arxiv.org/abs/2406.12045),
[tau2-bench](https://github.com/sierra-research/tau2-bench)). Agent + LLM-simulated user +
mock DB + API tools + a **policy document** (e.g. "basic-economy tickets cannot be changed").
Grading is fully programmatic: **final database state must equal the annotated goal state**
(tasks designed so policy + goal admit exactly one correct outcome), plus assertions that
required facts were communicated to the user. Introduced **pass^k** (succeed on all k reruns):
GPT-4o retail fell from <50% pass^1 to ~25% pass^8. Our bench already reports pass^k; τ-bench
is the precedent for state-diff grading of policy-constrained conversations.

**Toolathlon** (HKUST, 2025-10, [arXiv:2510.25726](https://arxiv.org/abs/2510.25726)). The
closest public analogue to our integrations surface: 108 tasks across 32 real apps / 604 tools
via MCP (email, calendar, Notion, Slack-like chat, GitHub, BigQuery…) with realistic initial
state (populated inboxes, dozens of docs). Example shape: process incoming email,
cross-reference calendar and files, update Notion, notify people. Grading: **a dedicated
execution-based verification script per task** checks final state in the real apps; Docker
reset between runs; no LLM judge. Best model at release: 38.6%.

**CRMArena-Pro** (Salesforce, 2025, [arXiv:2505.18878](https://arxiv.org/abs/2505.18878)).
~4,280 queries against a live sandboxed Salesforce org with schema-faithful generated data.
Programmatic answer/state checks; single-turn (~58%) vs multi-turn with clarifying questions
(~35%); also grades **confidentiality awareness** (near-zero pass without explicit prompting).

**Gaia2 + ARE** (Meta, 2025-09, [huggingface.co/blog/gaia2](https://huggingface.co/blog/gaia2)).
1,120 scenarios in a simulated phone (email, messaging, calendar). Novelty: **asynchronous
events** — the environment keeps moving while the agent thinks (a reply arrives at t=300s);
write actions verified against annotated oracle actions; **budget-aware scoring** (performance
vs cost curves) is first-class.

**WebArena / OSWorld** ([arXiv:2307.13854](https://arxiv.org/html/2307.13854v4),
[arXiv:2404.07972](https://arxiv.org/abs/2404.07972)). Self-hosted site replicas / a real OS
VM. Verification is a per-task **getter + assertion on post-hoc environment state**: query
GitLab's API to confirm the repo exists with the right collaborators; read Chrome's cookie
SQLite to confirm the Amazon cookies are gone. OSWorld 2.0 (2026) added **checkpoint-based
partial credit** (avg ~27 checkpoints/task, ~88.5% of score deterministic, ~11.5% from
individually validated model-based checks used only where rules cannot judge).

### Code and terminal, graded by hidden tests

**SWE-bench Verified / Pro** ([openai.com](https://openai.com/index/introducing-swe-bench-verified/),
[arXiv:2509.16941](https://arxiv.org/pdf/2509.16941)). Real GitHub issue + repo at the pre-fix
commit; grading applies the agent's patch and runs hidden **fail-to-pass** tests (issue is
fixed) plus **pass-to-pass** tests (no regressions). The Verified lesson: ~1/3 of raw scraped
tasks were broken (underspecified issues, unfair tests) and had to be human-screened on a
severity rubric — and even then ~31% of "resolved" patches pass on inadequate tests. The
verifier is only as good as its tests. Pro adds a private commercial split; the public/private
score gap doubles as a contamination detector.

**Terminal-Bench 2.0** ([tbench.ai](https://www.tbench.ai/docs)). Each task: instruction,
Dockerfile start state, per-task time limit, a human **oracle solution that must pass**, and
pytest run **against the final container state** (never the transcript — any path to the end
state counts). Task admission gates: *specificity* (instruction fully defines acceptable end
states), *solvability* (oracle passes), *integrity* (tests hidden from the agent filesystem).

**SWE-Lancer** (OpenAI, 2025-02, [arXiv:2502.12115](https://arxiv.org/abs/2502.12115)). 1,400+
real Upwork tasks worth $1M in historical payouts; IC tasks graded by **end-to-end Playwright
tests** (user-flow level, triple-verified — far harder to game than unit tests); headline
metric is **dollars earned**.

**MLE-bench** (OpenAI, [arXiv:2410.07095](https://arxiv.org/html/2410.07095v5)). 75 Kaggle
competitions; the agent's `submission.csv` is scored locally and mapped onto the **real human
leaderboard** (medal thresholds) — grading against a human distribution when quality is
continuous. Includes rules-compliance checking and plagiarism detection.

### Short-answer research

**GAIA** ([arXiv:2311.12983](https://arxiv.org/abs/2311.12983)) and **BrowseComp**
([openai.com/index/browsecomp](https://openai.com/index/browsecomp/)). Multi-step tool-use
questions with a single short verifiable answer, graded by quasi-exact match. The design
manifesto both follow: exploit the **asymmetry of verification** — tasks hard to do, trivial
to check — and build questions by inverting from an obscure fact so the answer cannot be
memorized or searched directly. BrowseComp adds canary GUIDs for contamination and grades
answer **calibration** alongside accuracy.

### Long-horizon economics

**Vending-Bench 2** (Andon Labs, [andonlabs.com/evals/vending-bench-2](https://andonlabs.com/evals/vending-bench-2)).
Run a simulated vending business for 365 simulated days (email suppliers, negotiate, price,
restock; adversarial suppliers and delivery failures). Grading: **final bank balance**,
averaged over 5 runs — a single ungameable outcome number. The headline result is variance:
V1's "meltdown" trajectories established worst-run behavior as a reportable metric.

### Methodology: cost-controlled comparison

**HAL — Holistic Agent Leaderboard** (Princeton, [hal.cs.princeton.edu](https://hal.cs.princeton.edu/))
and its methodology paper ["AI Agents That Matter"](https://arxiv.org/abs/2407.01502). 21k+
rollouts across 9 models × 9 benchmarks × multiple scaffolds. The field's reference practice
for exactly what our bench targets: results as **accuracy-vs-cost Pareto frontiers**, never
1-D rankings (agents can be 100× more expensive for +1% accuracy); model × scaffold
interactions are strong, so fix one when comparing the other; in 21/36 combinations **higher
reasoning effort gave equal or worse accuracy**; simple baselines (single call, retry) often
sit on the frontier and must be included. Their LLM-aided log inspection caught agents looking
up benchmark answers on HuggingFace — audit transcripts, don't just score them.

## The grading ladder

How the field verifies "done", ordered by objectivity and cost. Mature benchmarks layer these;
the rule everywhere is **grade outcomes, never trajectories or wording**.

1. **Hidden behavioral tests** — fail-to-pass suites, pytest on final container state
   (SWE-bench, Terminal-Bench). Strongest, for anything executable.
2. **Programmatic end-state checks** — getter + assertion on DB rows, API reads, files, sent
   messages (τ-bench, Toolathlon, WebArena, OSWorld). The workhorse for integration work; our
   v1 `assert(evidence)` predicates are already this pattern.
3. **Grading against a human distribution** — score mapped to a human leaderboard or reference
   deliverable (MLE-bench medals, GDPval/RLI pairwise). For continuous quality.
4. **Checkpoints with partial credit** — ordered milestones, each deterministically verified
   where possible, model-verified only where rules can't judge, with a completion bonus so
   partial credit never beats finishing (TheAgentCompany's `0.5·fraction + 0.5·full`,
   OSWorld 2.0's ~27 checkpoints with model checks capped at ~11.5% of score).
5. **Rubric-tree LLM judges** — for answer/report-shaped work: binary leaf criteria (never
   holistic 1–10 scores), critical nodes that gate vs non-critical nodes that average
   ([Mind2Web 2](https://arxiv.org/pdf/2506.21506): avg 50-node trees, judge validated at ~99%
   human agreement; judges must be calibrated on human-labeled samples, ~75–90% agreement
   before trusting), plus programmatic fact/citation verification on the side (FACT).
6. **Blind pairwise expert grading** — the gold standard for "would a client accept this",
   used to calibrate the cheaper layers, too expensive as the everyday grader.

Cross-cutting practices we should treat as requirements:

- **Every task ships an oracle solution** and passes Terminal-Bench's three gates
  (specificity, solvability, integrity) before admission. Expect ~1/3 of first-draft tasks to
  be broken (SWE-bench Verified's screening rate).
- **Repeats with distribution, not means**: pass@1 over n≥3 runs with error bars, pass^k for
  reliability claims (already in our bench), worst-run behavior for long-horizon cases.
- **Cost/latency as first-class axes**: per-trial USD from real gateway cost (we do this),
  tokens split in/out/cached, steps, wall-clock; present model comparisons as
  accuracy-vs-cost frontiers with cheap baselines included.
- **Anti-gaming and contamination**: verifiers must be unsatisfiable by degenerate states;
  keep graders/fixtures out of the agent-visible surface; canary strings; a private task
  split once anything is public; audit transcripts for shortcut behavior.
- **Realistic mess is the difficulty**: distractor files, information split across sources,
  underspecified asks. APEX/RLI/GDPval all find failures concentrate in ambiguity handling,
  discovery, and finishing/packaging — not knowledge or reasoning.

## What our production workloads actually are

Sanitized analysis of succeeded manual tasks in the prod DB (2026-07 → 2026-09, single-founder
account; prompts and outcomes reviewed, names/ids omitted). Four shapes dominate:

1. **Deep research with explicit scope** (dominant, ~60%): market teardowns, growth analyses
   ("how did X grow 0→$10M"), pricing-vs-market checks, technical landscape studies, prospect
   research. Long prompts with named deliverables. Maps to DeepResearch Bench / BrowseComp /
   GDPval-style grading (rubric tree + fact checks), not exact match.
2. **CRM and PM writes through integrations**: create person records and add them to a CRM
   list, leave a comment on a record, detach issues from a project via API. Maps exactly to
   τ-bench/Toolathlon end-state grading. Notably, several of these carried
   `reported_outcome: needs_attention` — real failures waiting to become regression cases,
   which is the harness-bench "prod-failure flywheel" working as intended.
3. **List building against an ICP** (~20-founder target lists, guest sourcing with fit
   criteria): gradeable as APEX-style binary criteria checklists (count, per-entry required
   fields, verifiable fit constraints).
4. **Strategic prep from Brain context** (board-prep analysis pulling an existing Brain memo):
   requires workspace-state fixtures (Brain docs), graded by rubric + "cites the right source
   figures" checks.

Also relevant: `task_model_usage` already records per-task model usage, and the same task
shapes ran across four model families in prod — the model-matrix comparison is a real
workload, not hypothetical.

## Implications: the first ambitious case

Two tracks, matching the [harness-bench](./harness-bench.md) constraint that v1 fixtures cover
only the action tools and grading is deterministic.

**Track A — lands in v1 as-is (do first).** A cross-tool workload from production shape 2,
inside the captured PostHog + Linear catalogs: *"Our activation funnel insight looks off since
the release — check the numbers and file a Linear issue for the team with the actual figures
if the drop is real."* Fixture returns a PostHog insight with a specific value; assertions
check the discovery flow, exactly one Linear write whose params carry the figure from the
PostHog result (cross-tool data flow), the figure appearing in `final`, and an `approvalAction`
on the write. Raise `budgets.steps`/`toolCalls` above the 6-step v1 cases. This is
τ-bench-grade end-state verification with zero new machinery — only a scenario file.

**Track B — the real-work case (needs v2 machinery, in order of cost):**

1. **Checkpoint grading** (TheAgentCompany/OSWorld 2.0 pattern): extend `assert` predicates
   with point-weighted checkpoints and the `0.5·fraction + 0.5·full` score, so long scenarios
   yield signal before models can fully pass them. Pure TypeScript, no judges.
2. **Rubric-tree judge for research deliverables** (Mind2Web 2/RACE pattern): binary leaves,
   critical vs non-critical nodes, judge model pinned and versioned in the report, calibrated
   once against human grading of a handful of real prod task outputs before it counts.
   This unlocks production shape 1 — the dominant workload — e.g. a sanitized replay of a real
   growth-analysis task, with FACT-style programmatic citation checks alongside.
3. **Workspace-state fixtures** (wiki/brain/web tools): unlocks shape 4 and Toolathlon-style
   multi-app cases. Largest lift; sequence last.

Every new case follows the admission gates above: oracle run that passes, specificity check,
grader invisible to the agent, k≥4 trials, cost recorded on failures too.
