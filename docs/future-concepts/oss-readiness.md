# Open-source release readiness

- Status: Ready for attended publication
- Last reviewed: 2026-09-07

## Current state

The engineering monorepo is private and licensed under MIT. The repository owner formally approved
MIT as the final project license on 2026-09-04; the decision, notice policy, trademark boundary,
and contribution terms are recorded in [OPEN_SOURCE.md](../../OPEN_SOURCE.md). Its application
boundaries, public pull-request CI, local setup, release automation, and contributor documentation
are materially more mature than when open-source preparation began, but repository visibility has
not changed.

MIT remains authoritative. A future license change requires a separate owner decision plus legal
and provenance review; this proposal does not authorize one.

## Release goal

If opencompany publishes this repository, publish the complete engineering monorepo rather than a
drifting source snapshot. Keep deployable apps, shared packages, migrations, documentation, and the
checks required to review changes together. Production credentials, private customer data, and
company-only environment bindings remain outside the repository.

The initial launch promise is contribution support, not production-grade self-hosting. Contributors
can install dependencies, understand the runtime boundaries, and execute the repository's core
checks. The current full-stack setup remains maintainer-oriented because it depends on
opencompany-managed services. A credential-independent path for core local development is a planned
follow-up, and provider-backed features may still require personal credentials.

## Remaining release gates

All pre-publication gates are resolved. The remaining operations require the repository to be
public and are sequenced in the [public launch runbook](../public-launch-runbook.md):

- the repository owner changes visibility without renaming the repository;
- a maintainer immediately sets Actions approval to `all_external_contributors` and enables private
  vulnerability reporting; and
- a true external fork exercises the held-run, credential-free `PR gate`, and review requirement.

If either public-only setting cannot be verified, return the repository to private before announcing
the launch or accepting an external pull request.

## Resolved release policy

- **License and notices (resolved 2026-09-04):** MIT is the owner-approved final project license.
  MIT requires preservation of its copyright and permission notice but no project-level `NOTICE`.
  Copied material is tracked in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
- **Trademarks (resolved 2026-09-04):** the MIT license does not grant rights to project branding;
  permitted referential use and fork requirements are documented in
  [TRADEMARKS.md](../../TRADEMARKS.md).
- **Contributions (resolved 2026-09-04):** contributions are inbound=outbound under MIT. No CLA or
  DCO sign-off is required, and repository web-editor sign-off is disabled to match. Contributors
  represent that they have the right to submit their work. See
  [CONTRIBUTING.md](../../CONTRIBUTING.md).
- **Publication inventory (resolved 2026-09-07):** tracked skills, fixtures, images, icons, and fonts
  were inventoried. Required copied-material provenance remains in
  [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md); the file stays because the covered Vercel
  skill, Firecrawl fixtures, and Simple Icons paths remain in the tree.
- **Review and production (resolved 2026-09-07):** external contributions require one CODEOWNER
  approval and execute no Actions workflow until a maintainer approves the held run. The two active
  maintainers have PR-only review bypass for maintainer-authored work, but the required `PR gate`,
  force-push, and deletion rules have no bypass. Default CodeQL remains enabled for trusted changes
  but is not required because its default setup does not scan fork pull requests. Production deploys
  verified `main` automatically, accepts no other branch, and disallows administrator bypass. See
  [CI security](../ci-security.md).
- **Hosted fork controls (owner-confirmed 2026-09-07):** Infisical's OIDC boundary and Vercel Fork
  Protection are configured and working. This records the release owner's confirmation without
  storing hosted configuration or credential values in the repository.
- **History and contributor privacy (resolved 2026-09-07):** the final scan covered every live
  branch and pull-request head intended to remain reachable: 4,935 unique commits across eight
  branches and 1,485 pull-request refs. The publication owner confirmed that the contributors whose
  personal addresses remain in commit attribution are aware and consent; no objection requires a
  history rewrite. Work and organization addresses remain ordinary Git attribution. See
  [Git contributor email privacy](../contributor-email-privacy.md).
- **Secrets (resolved 2026-09-07):** an independent TruffleHog scan over the same refs found no
  verified credentials. Its four unverified findings all point to one documented dummy PostgreSQL
  test fixture, not a live account.
- **Deployment metadata and maintenance tools (resolved 2026-09-07):** tracked Render and Vercel
  files contain topology, build commands, disabled deployment flags, placeholders, and environment
  variable names rather than credentials or live project bindings. The Infisical selector is
  non-secret. One-off maintenance scripts require explicit operator inputs and are not reachable
  from the untrusted pull-request workflow. No launch-critical deletion is warranted.
- **Community policies:** [SECURITY.md](../../SECURITY.md) and
  [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md) define the current reporting and conduct paths.

## Tracked follow-up

- Document and exercise a credential-independent core local-development path from clean macOS and
  Linux clones. Until then, the README and getting-started guide must continue to state that the
  full-stack setup requires access to opencompany-managed services.

New copied or externally sourced material must continue to satisfy the provenance and notice policy
before merge.

## Non-goals

- Reorganizing the accepted `apps/*` and `packages/*` architecture for launch optics.
- Renaming historical physical database schemas or rewriting applied migrations.
- Promising hosted-service parity or support for every optional provider.
- Publishing npm packages merely because the source repository becomes visible.
- Changing the license as an incidental part of engineering cleanup.

The repository is ready for the attended visibility change and immediate public-only verification in
the launch runbook. Readiness remains open until that sequence and its external-fork canary complete.
