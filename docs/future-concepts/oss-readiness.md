# Open-source release readiness

- Status: Proposed
- Last reviewed: 2026-09-04

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

The initial promise should be development-supported community setup, not production-grade
self-hosting. Provider-backed features may be unavailable without personal credentials, but a new
contributor should be able to install dependencies, understand the runtime boundaries, run the
documented local path, and execute the same core checks as maintainers.

## Remaining release gates

- Complete a provenance and redistribution audit for source, fonts, images, screenshots, generated
  artifacts, and third-party examples.
- Follow the accepted [Git contributor email privacy](../contributor-email-privacy.md) decision:
  rerun independent secret and personal-data scans over every Git ref intended for publication,
  privately notify contributors whose history contains personal or otherwise non-public addresses,
  and resolve objections before deciding whether the coordinated history-rewrite exception is
  necessary.
- Confirm public-release maintainer ownership and operational coverage.
- Exercise setup from clean macOS and Linux clones without company Infisical, Neon, Vercel, or
  Render access.
- Apply and verify the public-repository `all_external_contributors` workflow approval policy during
  the visibility change. The versioned PR isolation and private fail-closed settings are documented
  in [CI security](../ci-security.md).
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
  DCO sign-off is required; contributors represent that they have the right to submit their work.
  See [CONTRIBUTING.md](../../CONTRIBUTING.md).
- **Community policies:** [SECURITY.md](../../SECURITY.md) and
  [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md) define the current reporting and conduct paths.

These decisions do not close the separate provenance and redistribution audit for tracked source,
assets, fixtures, or generated material.

## Non-goals

- Reorganizing the accepted `apps/*` and `packages/*` architecture for launch optics.
- Renaming historical physical database schemas or rewriting applied migrations.
- Promising hosted-service parity or support for every optional provider.
- Publishing npm packages merely because the source repository becomes visible.
- Changing the license as an incidental part of engineering cleanup.

This proposal remains active until the owner either approves a publication runbook or explicitly
retires the open-source release goal.
