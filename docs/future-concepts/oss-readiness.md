# Open-source release readiness

- Status: Proposed
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

- Follow the accepted [Git contributor email privacy](../contributor-email-privacy.md) decision:
  rerun independent secret and personal-data scans over every Git ref intended for publication,
  privately notify contributors whose history contains personal or otherwise non-public addresses,
  and resolve objections before deciding whether the coordinated history-rewrite exception is
  necessary.
- Apply and verify the public-repository `all_external_contributors` workflow approval policy during
  the visibility change. The versioned PR isolation and private fail-closed settings are documented
  in [CI security](../ci-security.md).
- Exercise one external-fork canary after publication: confirm that opening the pull request starts
  no workflow, explicitly approve the held run, then confirm that the credential-free `PR gate`
  completes and the contribution remains review-gated.
- Enable private vulnerability reporting after publication and verify the private reporting path.
- Audit tracked deployment metadata and one-off maintenance tools; retain only what is safe and
  useful to forks.
- Verify dependency, migration, documentation-link, secret, and build checks from the public CI
  path.
- Make repository visibility the final, explicit owner-approved operation with a rollback and
  incident-response owner present.

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

This proposal remains active until the owner either approves a publication runbook or explicitly
retires the open-source release goal.
