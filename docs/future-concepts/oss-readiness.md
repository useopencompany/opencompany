# OpenCompany monorepo hygiene and open-source readiness

- Status: Proposed decision document
- Date: 2026-08-14
- Decision owner: OpenCompany owner
- Predecessor: [#1203](https://github.com/useopencompany/opencompany-experimental/issues/1203)
- Completion evidence:
  [#1203 final comment](https://github.com/useopencompany/opencompany-experimental/issues/1203#issuecomment-5289844745)
- Architecture baseline: [ADR 0001](../adr/0001-headless-chat-v1-foundation.md),
  [ADR 0002](../adr/0002-headless-task-v1-foundation.md), and
  [ADR 0003](../adr/0003-headless-workflow-and-schedule-foundation.md)

## Purpose

Issue #1203 is complete. Its final production evidence establishes the steady-state architecture:
`apps/web` is a presentation/authentication shell, `apps/api` is the authenticated product and
provider-ingress boundary, `apps/runner` owns durable execution and background work, and shared
application behavior and adapters live in `packages/core`, `packages/protocol`, and `packages/db`.
This project documents and presents that architecture; it does not reopen it.

The remaining question is whether the repository around that architecture is safe, legible, and
honest enough to make public. This document asks the owner to make six calls before any broad
rename, move, deletion, relicensing, or visibility change begins.

## Recommended decision sheet

| Area | Recommended call | Owner decision |
| --- | --- | --- |
| Naming | Use OpenCompany for every public and code-facing name; retain legacy physical `goat.*` storage names. | Pending |
| Layout | Keep the `apps/*` and `packages/*` architecture, improve its signposting, and extract the existing Fumadocs surface to `apps/docs`. | Pending |
| Open boundary and license | Open the full engineering monorepo under Apache-2.0 after a provenance and asset audit. | Pending |
| Secret and history safety | Scan a mirror of every ref with two detectors; rotate first and rewrite only when publication hygiene or sensitive data requires it. | Pending |
| Contributor surface | Launch as maintainer-led OSS with curated external contributions and fully untrusted PR CI. | Pending |
| Sequence | Land small gated slices; make repository visibility the final, explicitly approved operation. | Pending |

Effort estimates below are engineering time, not elapsed calendar time. They exclude legal review,
provider response time, and any incident response caused by a historical secret finding.

## Decision 1: Naming

### Current state

The product is OpenCompany, the GitHub organization is `useopencompany`, and all 22 workspace
package manifests use the private `@opencompany/*` scope. `apps/runner` accurately describes the
durable worker composition root. The accepted ADRs deliberately use the neutral public vocabulary
Conversation, Message, Run, Task, Workflow, Actor, and Workspace.

The old Goat codename is still pervasive below that boundary:

- four shared packages are named `goat-agent`, `goat-brain`, `goat-observability`, and `goat-wiki`;
- 627 tracked paths contain `goat`, and 920 tracked text files contain the word;
- `.env.example` declares 50 `GOAT_*` variables and six `OPENCOMPANY_*` variables;
- the product schema is physically `goat`, 215 immutable migrations encode that name, and retained
  values such as `goat-chat` are persisted compatibility contracts;
- Infisical still uses `/goat` for the web/local compatibility namespace; and
- user-facing components and assets still include names such as `GoatSurface` and `GoatMark`.

These are not equally expensive. TypeScript symbols, filenames, package imports, comments, and UI
copy are code-only changes. Package directory changes are broad but mechanical. Environment names,
provider URLs, OAuth audiences, host configuration, release preflights, and Infisical paths are
deployed contracts. Physical schemas, tables, constraints, stored enum-like values, and applied
migration history are data contracts.

### Options

| Option | Benefits | Costs and risks |
| --- | --- | --- |
| Keep Goat everywhere | Lowest immediate change and deployment risk. | Makes a cold reader wonder whether Goat and OpenCompany are different products; turns a historical codename into a permanent public API. |
| Rename every Goat reference, including storage | Produces a perfectly uniform tree and database. | High-risk, low-value data migration; rewrites or layers compatibility across 215 migrations, tables, constraints, projections, provider configuration, and production secrets. It contradicts the additive/fix-forward posture of ADRs 0001–0003. |
| Rename the public/code surface and retain physical compatibility names | Makes the contributor and self-hosting contract coherent without risking customer data or migration history. | Requires an explicit legacy boundary and a coordinated environment migration; some `goat` names remain visible to repository readers in storage code and historical ADRs. |

### Recommendation

Choose the bounded rename.

- OpenCompany is the only product name in UI copy, current docs, examples, supported configuration,
  package names, and non-historical code symbols. Historical ADRs and migrations remain honest.
- Keep `apps/runner`. `runner` says what the process does and is already the accepted architecture;
  renaming it to a brand or to `worker` would lose information.
- Keep `@opencompany/*`. Confirm control of the npm organization before publishing any package, and
  keep the root and internal packages `private: true` unless a specific SDK is intentionally
  published.
- Rename the four Goat packages by role: `@opencompany/agent`, `@opencompany/brain`,
  `@opencompany/telemetry`, and `@opencompany/wiki`. Rename code-only `goat-*` modules similarly,
  including `goat-schema.ts` to `product-schema.ts`, while leaving `pgSchema("goat")` untouched.
- Keep `packages/core`, `packages/protocol`, and `packages/db`. Together they match the accepted
  application/contract/adapter layering. Package READMEs and an enforced dependency map will make
  that story clearer than renaming `core` to another generic noun.
- Make `OPENCOMPANY_*` the supported environment contract before the repository becomes public.
  Add temporary reads for the corresponding `GOAT_*` names, migrate Vercel, Render, Infisical,
  setup, docs, and release preflights, then remove aliases after two successful production releases
  and evidence that no legacy name was read.
- Replace the Infisical `/goat` path with runtime-aligned `/web` configuration during that same
  controlled migration. Keep `/api`, `/runner`, and `/release`. This is an operational rename, not a
  prerequisite for the code-only package PR.
- Permanently retain the physical `goat` Postgres schema, existing table/constraint names, stored
  compatibility values, and applied migration filenames. Document them once as a legacy physical
  namespace behind `packages/db`; do not burden every contributor-facing page with the history.

This challenges #1203's rename non-goal only where the name is about to become a public contributor
contract. It confirms the non-goal for physical storage, where a rename adds no product value and
creates the most risk.

## Decision 2: Monorepo layout

### Current state

The main shape is sound: deployable composition roots live in `apps/*`, reusable code lives in
`packages/*`, immutable migrations live in `drizzle/`, repository automation lives in `scripts/`,
and accepted decisions live in `docs/adr/`. Root architecture docs describe the completed headless
boundary accurately.

The cold-start experience does not yet match that architecture:

- `apps/api`, `apps/web`, `apps/runner`, `packages/core`, `packages/protocol`, and `packages/db` have
  no local README explaining ownership, imports, or how to test them;
- the root quick start assumes access to OpenCompany's Infisical and Neon projects;
- contributor/operator docs are split between root `docs/`, `apps/web/docs/`, and
  `apps/web/content/docs`;
- Fumadocs is already installed in `apps/web`, and `/docs` is built as part of the main product
  deployment;
- the top-level `hubspot/goat-brain-app` project and one-off Goat maintenance scripts do not fit the
  documented root map; and
- package names such as `core`, `db`, and `protocol` make sense together but are not self-explanatory
  when viewed independently.

### Options

| Option | Benefits | Costs and risks |
| --- | --- | --- |
| Keep the tree and only expand the root README | Smallest diff and no deployment changes. | Leaves public docs coupled to product deploys, package boundaries implicit, and the external quick start broken. |
| Reorganize around domain folders or services | Domain names may be easier to browse in isolation. | Reopens the architecture, blurs composition roots versus shared code, and creates import churn without changing behavior. |
| Preserve the architecture and add deliberate wayfinding | Makes the existing design obvious while limiting moves to genuinely misplaced documentation/tooling. | Requires a docs deployment and a focused cleanup of root-level exceptions. |

### Recommendation

Preserve `apps/*` versus `packages/*` and make the dependency story explicit:

```text
apps/web       apps/docs
     \           /
      packages/protocol
              |
apps/api   packages/core   apps/runner
     \          |           /
             packages/db
```

The diagram describes ownership, not a strict import graph: `apps/api` and `apps/runner` compose
application services with database adapters, while clients depend on the protocol rather than the
database. Existing packages for UI, billing, agent execution, and other reusable behavior stay
under `packages/*`; do not create a package per route or domain.

Land the following layout contract:

- `apps/web`: authenticated product presentation and auth shell only.
- `apps/api`: public `/v1` and provider-ingress composition root.
- `apps/runner`: durable execution and background-work composition root.
- `apps/docs`: the existing Fumadocs-based, user-facing product and API documentation. Move the
  current public MDX content out of `apps/web`; generate API reference from
  `packages/protocol/openapi/openapi.v1.json`; do not give the docs app database or core imports.
- `apps/marketing`: independently deployed marketing site, still part of the engineering monorepo.
- `packages/protocol`, `packages/core`, `packages/db`: wire contract, framework-free application
  behavior/ports, and persistence adapters. Give each a short README with allowed dependencies,
  stable entry points, and focused verification commands.
- `docs/`: contributor, architecture, self-hosting, operator, ADR, and future-decision sources.
  ADRs remain in `docs/adr`; speculative proposals remain in `docs/future-concepts`. Public product
  content lives in `apps/docs` and links to these sources rather than copying them.
- `scripts/`: supported repository-wide setup, verification, release, and maintenance entry points.
  Group retained one-off data tools under a clearly marked maintenance subdirectory with owners and
  safety notes; delete obsolete measurement/migration scripts only after a caller audit.
- provider deployment projects such as the HubSpot app: place them under one documented
  `integrations/` or `deploy/` root rather than a provider-named exception at repository root.

A newcomer's first ten minutes should be deterministic:

1. The root README states what OpenCompany is, shows the three-runtime diagram, links a live demo or
   screenshot, and offers internal and community setup paths.
2. `bun install --frozen-lockfile` and one documented community setup command work without access to
   OpenCompany's Infisical, Neon, Vercel, or Render accounts. Provider-backed features may be
   disabled, but the web/API/runner path must boot and explain missing optional capabilities.
3. `bun run dev:web` starts the supported local stack, and one smoke command verifies API and runner
   health without requiring production data.
4. `CONTRIBUTING.md` tells the reader where a UI, API contract, application service, repository,
   worker, migration, and doc change belongs.

Do not call the repository self-hostable until that community path is exercised from a clean clone
on macOS and Linux by someone without company credentials.

## Decision 3: License and open boundary

### Current state

The repository is private and carries an MIT license with an `opencompany` copyright line. Every
workspace package is private. The tracked tree includes product apps and packages, the marketing
site, generic and production release automation, Infisical and Vercel project bindings, a HubSpot
deployment project, repository-local agent skills, and optional Conductor configuration.
`.context` is untracked in this clone only through `.git/info/exclude`; it is not protected by the
repository `.gitignore`. The live `.infisical.json` and `.vercel/project.json` contain project
identifiers that are not credentials but are company-specific and useless to a fork.

### Boundary options

| Option | Benefits | Costs and risks |
| --- | --- | --- |
| Open the full engineering monorepo | One source of truth; public CI, migrations, deployment discipline, marketing, and agent tooling can be reviewed with the product. | Requires a broader provenance, personal-reference, asset, and operational-metadata audit. |
| Open only product apps/packages | Smaller public surface and less exposure of commercial operations. | Creates a private/public split for the lockfile, shared UI, scripts, releases, and docs; contributors cannot reproduce maintainer checks. |
| Publish a curated source snapshot | Maximum control over what appears publicly. | Almost guarantees drift, makes external contributions difficult to land, and undermines trust in the public repository. |

### License options

| Option | Implication |
| --- | --- |
| MIT | Already present, short, permissive, and familiar. It has minimal notice obligations but no express patent grant in its text. |
| Apache-2.0 | Permissive and commercially usable, with an explicit contributor patent grant and patent-termination terms. It requires preserving license/notice information and does not grant trademark rights. |
| FSL-1.1 or BUSL-1.1 style | Makes source available while restricting some production or competitive use. FSL versions convert to MIT or Apache-2.0 after two years; BUSL converts by its chosen change date, no later than four years. Neither is open source before conversion, so choosing one changes the project claim and contributor expectation. |

See the official [Apache-2.0 text](https://www.apache.org/licenses/LICENSE-2.0),
[FSL description](https://fsl.software/), and [BUSL-1.1 text](https://mariadb.com/bsl11/) for the
controlling terms. License selection and copyright provenance require owner/legal approval; this
document is an engineering recommendation, not legal advice.

### Recommendation

Open the full engineering monorepo under Apache-2.0.

The architecture, migrations, checks, and release automation are part of the product's credibility;
hiding them would make the public tree less useful and create a costly mirror. Apache-2.0 preserves
permissive commercial adoption while making the patent grant explicit for a company-led project
that intends to accept outside contributions. If the owner wants a competitive-use restriction,
choose FSL/BUSL deliberately and call the launch source-available, not open source.

"Full monorepo" means authored source and reproducible tooling, not live workspace state:

- include all product apps/packages, migrations, generic setup/release automation, GitHub workflows,
  the docs and marketing apps, provider deployment definitions, and scrubbed repo-local agent or
  Conductor guidance;
- keep `.context/`, generated logs, local env files, local MCP configuration, and downloaded source
  material ignored at repository level;
- replace live Infisical/Vercel project bindings with examples or environment-driven setup. Secret
  names and generic release logic may remain public; secret values, account IDs, project IDs, and
  private operational endpoints may not;
- audit marketing and docs media for ownership and third-party license obligations. Keep authored
  marketing code/content in the repo; remove or separately license only assets that cannot be
  distributed under the repository license; and
- publish a trademark policy for the OpenCompany name and logo. Apache-2.0 does not grant trademark
  rights, so there is no need to hide the marketing application merely to protect the brand.

Before changing `LICENSE`, confirm the company can relicense all historical contributions and add
any required `NOTICE` or third-party attribution file. Use an inbound-equals-outbound policy plus a
Developer Certificate of Origin sign-off; do not add a CLA unless a real dual-licensing or ownership
need appears.

## Decision 4: Secret and history safety

### Current state

The default branch contains 1,092 commits, the repository has more than 1,200 merged PRs, and the
current clone has 13,697 commits reachable across all fetched refs. A current-tree pattern sweep
found documented placeholders and negative test fixtures, not an obvious live credential; that is
triage, not release evidence. It also found personal/internal identifiers that require a public
content review.

CI already runs a SHA-pinned TruffleHog action on each pull request/push range, and the local
`secrets:check` script scans `origin/main..HEAD`. Neither is the one-time all-ref, all-history gate
needed before a private repository becomes public. GitHub secret scanning, push protection, code
security, and Dependabot security updates are currently disabled. Main has strict required CI,
admin enforcement, and force-push/deletion protection, but requires zero approvals and does not
require CODEOWNER review. Actions default to a read-only token, but all marketplace actions are
allowed and repository-level SHA pinning is not enforced. CI actions are pinned; production release
actions still use mutable tags. The production environment has no protection rule.

### Options

| Option | Benefits | Costs and risks |
| --- | --- | --- |
| Trust current PR scanning | No additional work. | Misses secrets that exist only on old commits, deleted branches, or tags; unacceptable before publishing a large private history. |
| Scan default-branch history with one detector | Good coverage at moderate cost. | Misses other refs and detector classes; one false negative becomes permanently distributable. |
| Scan a mirror of all refs with complementary detectors | Strongest practical pre-public evidence and a reproducible audit record. | More triage and false positives; findings may delay launch and require provider coordination. |

### Recommendation

Create a temporary bare mirror after freezing pushes, fetch every branch and tag, and run both
TruffleHog and Gitleaks across all reachable history. Store reports in a restricted incident
location, never as repository or public CI artifacts. Inventory current repository, organization,
Actions, environment, deploy, OAuth, database, and provider credentials before triage so every
finding has an owner and a revocation path. Record only detector, commit/path, credential owner,
revocation status, and sanitized evidence in the launch checklist.

Use this response rule:

- A valid, possibly valid, or unverifiable credential is revoked or rotated first. Deploy and verify
  every consumer, then revoke the old value. History rewriting is never a substitute because clones,
  caches, logs, and forks may retain the original object.
- An expired credential is still checked with its issuer. Rewrite it before publication when the
  value, account identity, or surrounding content should not become permanent public history.
- Customer data, private keys, regulated data, or private contractual material triggers both
  incident/legal handling and a history rewrite from every ref before visibility changes.
- Benign placeholders, public IDs, and intentional test fixtures are documented through narrow
  detector allowlists only after human review; never add a broad path exclusion for `.env.example`,
  tests, migrations, or docs.

If a rewrite is required while the repository is private, freeze merges, preserve an access-
restricted evidence mirror, use `git filter-repo` on the exact objects, invalidate old pull-request
refs where GitHub permits, force-update every affected branch/tag, have maintainers reclone, and
rerun both scanners. If the value has ever left the private trust boundary, assume rewriting cannot
erase it and rotate regardless.

The public-repository gate is:

- replace branch protection with or mirror it in a visible `main` ruleset: pull requests required,
  branch current, four existing CI checks required, conversations resolved, one non-author approval,
  stale approvals dismissed, CODEOWNER approval for `.github/`, auth, schema/migrations, release,
  and security policy, admins enforced, and no force pushes or deletions;
- keep squash-only merges for linear history. Do not require signed commits at launch; DCO sign-off,
  immutable action pins, protected merges, and review provide more value with less contributor
  friction;
- restrict Actions to required publishers and full commit SHAs. Convert every release workflow
  action from a mutable tag to a full SHA before enabling repository-level pin enforcement;
- run fork code only on `pull_request` with a read-only token, no secrets, no OIDC, no production
  environment, no write-capable cache, and an isolated ephemeral runner with no private network
  access. Never check out untrusted fork code from `pull_request_target` or a privileged
  `workflow_run`. GitHub's [secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use)
  treats full-SHA pinning as the immutable option;
- keep deployment in a separate trusted post-merge workflow, restrict the production environment to
  `main`, and require an owner approval at least through the public-launch stabilization window;
- enable GitHub secret scanning, push protection, validity checks, dependency graph, Dependabot
  alerts/security updates, private vulnerability reporting, and CodeQL/default code scanning where
  supported; and
- add weekly grouped Dependabot updates for both the supported `bun` ecosystem and GitHub Actions.
  Use Dependabot rather than adding Renovate at launch; its current Bun support covers text
  `bun.lock`, and one updater avoids duplicate PRs and policy surfaces.

Keep range-based TruffleHog scanning in normal CI after the one-time full-history gate. Add a
scheduled full default-branch scan and rerun the mirror audit immediately before the visibility
change.

## Decision 5: Contributor surface

### Current state

The root README, CONTRIBUTING guide, CODEOWNERS, and pull-request template exist and accurately list
the internal checks. The README explains the architecture but its three-command quick start assumes
company Infisical/Neon access. CONTRIBUTING does not state the contribution model, support promise,
license/DCO terms, security-reporting path, or a credential-free setup. There is no SECURITY policy,
Code of Conduct, issue form, Dependabot configuration, or public example. The generated OpenAPI and
typed client provide a natural example surface, but none is packaged for a newcomer.

### Options

| Option | Benefits | Costs and risks |
| --- | --- | --- |
| Public code, contributions closed | Lowest maintainer load and clearest product control. | Gives up useful fixes and makes the repository feel published for inspection rather than collaboration. |
| Maintainer-led, curated contributions | Accepts focused value while keeping architecture, roadmap, and high-risk changes owner-controlled. | Requires triage discipline, labels, response expectations, and a reliable external setup path. |
| Community-first development | Maximizes participation and shared ownership. | Premature without multiple maintainers, public governance, contributor support capacity, and a stable self-hosting contract. |

### Recommendation

Launch as maintainer-led OSS. Explicitly welcome documentation, reproducible bug fixes, tests,
small UX improvements, and scoped integrations. Require an accepted issue or design discussion
before architecture, schema, authentication, billing, deployment, or broad refactor work. Do not
publish a performative `good first issue` backlog until maintainers can respond and merge promptly.
The product roadmap and final design calls remain owner-led.

Before launch, add:

- a README with product screenshot/demo, architecture diagram, community quick start, supported and
  optional providers, project maturity, license, security link, and contribution stance;
- CONTRIBUTING sections for the community setup, repository map, boundary rules, test selection,
  DCO sign-off, review expectations, and areas requiring prior design approval;
- SECURITY, Code of Conduct, support/maturity statement, issue forms for reproducible bugs and
  scoped proposals, and a security form that points to private vulnerability reporting rather than
  public issue content;
- CODEOWNERS teams or at least two maintainers for critical paths before making those reviews
  mandatory; and
- one `examples/api-client` application that creates and observes a canonical Run using the typed
  client against configuration supplied by the user. Gate it in CI. Add more examples only when a
  real public contract needs them.

Treat every pull request as hostile input. The untrusted lane must run frozen install, migration-
journal and schema/migration checks, formatting, the web boundary check, lint, typecheck, build,
unit/integration tests that use disposable local services, OpenAPI drift checks, example/docs builds,
license policy, and range secret scanning. It receives placeholders only. Tests that require a paid
provider, production-like credentials, or deployment run after merge in a trusted environment and
must not be required to give an external contributor useful feedback.

## Decision 6: Sequencing

### Current state

The runtime refactor succeeded because each slice was independently deployable and the deletion
window closed only after exact-SHA evidence. OSS readiness should use the same discipline. A single
rename/open-source PR would mix mechanical churn, legal decisions, production configuration,
history safety, contributor policy, and an effectively irreversible visibility change.

### Options

| Option | Benefits | Costs and risks |
| --- | --- | --- |
| One big hygiene/launch change | Short calendar if nothing fails. | Unreviewable, hard to revert, and unsafe when naming, licensing, credentials, and deployments interact. |
| Make the repo public, then clean it in place | Fastest announcement. | Publishes history and operational mistakes permanently before the safety work can help. |
| Gate independently landable slices and open last | Clear ownership, measurable evidence, and safe stopping points. | Longer calendar and repeated documentation/check updates. |

### Recommendation

Use the following order. No slice may rely on a future visibility change to be safe.

| Slice | Work and exit gate | Owner decision? | Estimate |
| --- | --- | --- | --- |
| 0. Ratify this document | Record the six calls, license counsel/provenance owner, contribution owner, npm-scope owner, and public-launch approver. | Yes | 0.5–1 day |
| 1. History and content safety | Freeze/fetch all refs; run both history scanners; inventory personal/internal references, dependencies, media provenance, and project bindings; rotate/rewrite if required; add repository-level `.context/` ignore. Exit with sanitized evidence and no unresolved finding. | Owner only if a finding requires incident scope or history rewrite. | 2–4 days, incident work unbounded |
| 2. Code-only naming | Rename user-facing/code-only Goat vocabulary and the four packages; update imports, generated artifacts, checks, and current docs. Do not touch physical schema, migration history, env names, or Infisical. | Approve exact package mapping. | 4–7 days |
| 3. Environment and operations naming | Add `OPENCOMPANY_*` aliases, migrate setup/hosts/Infisical/release preflight, deploy, observe two releases, then remove `GOAT_*` aliases and `/goat`. | Approve compatibility window and production cutover. | 3–5 engineering days plus two releases |
| 4. Layout, docs, and community setup | Add package/app READMEs and dependency map; extract Fumadocs to `apps/docs`; normalize provider/maintenance tooling; add the credential-free community setup and API example; test clean clones on macOS/Linux. | Approve supported self-hosting/maturity promise. | 6–10 days |
| 5. License and contributor surface | Complete provenance/asset report; switch to Apache-2.0; add notices/trademark/DCO, README/CONTRIBUTING/security/conduct/forms, and maintainer ownership. | Yes: license, trademark, and contribution policy. | 2–4 days plus legal review |
| 6. Public CI and repository controls | Harden/pin Actions, isolate fork CI, add dependency/license/docs/example gates, enable Dependabot/security features, configure ruleset/CODEOWNERS and production-environment protection. Prove a fork PR cannot access secrets or deploy. | Approve review and deploy policy. | 2–4 days |
| 7. Publication | Rerun full mirror scans and clean-clone checks, capture a repository/settings backup, review the exact tracked tree, switch visibility, verify clone/docs/issues/security reporting, and monitor the first public CI/deploy cycle. | Yes; this is the final irreversible call. | 1–2 days |

Slices 1–4 and most of 6 are mechanical after their narrow policy choices. Slices 0, 5, and 7 must
not proceed on inferred consent. If the owner retains MIT, keeps the `/goat` Infisical name, or
chooses product-only publication, revise the affected slices before implementation rather than
quietly mixing recommendations.

## Project non-goals

- Changing the web/API/runner ownership, canonical Conversation/Message/Run model, or direct
  runner-to-repository execution path established by ADRs 0001–0003.
- New product features, a UI redesign, new clients, microservices, a package per domain, or a new
  queue/orchestration system.
- Destructively renaming the physical `goat.*` schema, tables, constraints, stored compatibility
  values, IDs, or applied Drizzle migration history for cosmetic consistency.
- Deleting the 35 retained sessionless Task histories or weakening the compatibility boundary in
  ADR 0002.
- Running production migrations or changing repository visibility from an implementation PR
  without the explicit gates above.
- Promising production-grade self-hosting support, community governance, response-time SLAs, or a
  public package release before maintainers choose and staff those commitments.
