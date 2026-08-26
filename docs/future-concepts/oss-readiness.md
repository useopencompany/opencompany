# Open-source release readiness

- Status: Proposed
- Last reviewed: 2026-08-26

## Current state

The engineering monorepo is private and licensed under MIT. Its application boundaries, public
pull-request CI, local setup, release automation, and contributor documentation are materially more
mature than when open-source preparation began, but repository visibility has not changed.

No license change is accepted by this proposal. MIT remains authoritative unless the repository
owner completes a separate legal and provenance review and explicitly approves another license.

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
- Run independent secret and personal-data scans over every Git ref. Rotate findings before deciding
  whether history rewriting is necessary.
- Decide and document the final license, notices, trademark policy, contribution terms, security
  reporting path, code of conduct, and maintainer ownership.
- Exercise setup from clean macOS and Linux clones without company Infisical, Neon, Vercel, or
  Render access.
- Confirm untrusted pull requests cannot access secrets, deployment credentials, writable caches,
  production environments, or organization-scoped automation tokens.
- Audit tracked deployment metadata and one-off maintenance tools; retain only what is safe and
  useful to forks.
- Verify dependency, migration, documentation-link, secret, and build checks from the public CI
  path.
- Make repository visibility the final, explicit owner-approved operation with a rollback and
  incident-response owner present.

## Non-goals

- Reorganizing the accepted `apps/*` and `packages/*` architecture for launch optics.
- Renaming historical physical database schemas or rewriting applied migrations.
- Promising hosted-service parity or support for every optional provider.
- Publishing npm packages merely because the source repository becomes visible.
- Changing the license as an incidental part of engineering cleanup.

This proposal remains active until the owner either approves a publication runbook or explicitly
retires the open-source release goal.
