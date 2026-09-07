# Contributing

opencompany is maintainer-led and under active development. Focused contributions to documentation,
tests, user experience, integrations, and well-scoped bugs are welcome. Read
[SUPPORT.md](./SUPPORT.md), [SECURITY.md](./SECURITY.md), and
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) before contributing.

## Start With an Issue

Use the bug form for reproducible defects and the proposal form for changes in behavior or scope.
Get maintainer design approval before implementing changes to architecture, database schema,
authentication, billing, deployment, or broad cross-cutting refactors. An approved direction is not
a promise that every implementation will merge; maintainability, compatibility, and verification
still matter.

Keep pull requests focused. Explain the problem, the chosen boundary, user-visible behavior, tests,
and anything reviewers cannot verify locally. UI changes need a browser check of the real route,
including the primary flow and an obvious error or empty state.

## Commit Identity and Email Privacy

Git records the author and committer email address in every commit. That metadata is visible when a
repository is public. If you do not want a personal address published, use the GitHub-provided
`noreply` address shown in your GitHub email settings:

```bash
git config user.email "YOUR_NOREPLY_EMAIL"
```

Run that command in this repository to override your global Git identity, or add `--global` to use it
for future commits in every repository. Confirm the configured value with `git config user.email`
before committing. Changing the setting does not alter existing commits.

GitHub can also keep the address private for web-based operations and block command-line pushes that
expose an address marked private. See [GitHub's commit email
guide](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)
and [push protection
guide](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/blocking-command-line-pushes-that-expose-your-personal-email-address).
The project's handling of existing commit metadata is documented in [Git contributor email
privacy](./docs/contributor-email-privacy.md).

## Contribution Terms

Unless a separate written agreement says otherwise, every contribution intentionally submitted to
this repository is licensed under the project's [MIT License](./LICENSE) on the same terms as the
rest of the project. You retain ownership of your contribution.

By submitting a contribution, you represent that you created it or otherwise have the right to
submit it under MIT. Do not submit employer-owned, confidential, copied, or generated material
unless you have the permissions needed to do so and can identify any third-party source and license.
Maintainers may ask for provenance evidence or require unclear material to be removed.

The project does not require a contributor license agreement or Developer Certificate of Origin
sign-off. Opening a pull request does not transfer copyright or grant rights to the opencompany
name or logos; see [OPEN_SOURCE.md](./OPEN_SOURCE.md) and [TRADEMARKS.md](./TRADEMARKS.md).

## External Pull Requests and CI Approval

Pull requests from maintainers with write access and trusted automation start CI normally. For
public contributions, GitHub holds every workflow run opened from an outside contributor's fork
until a maintainer reviews the proposed commit and explicitly approves that run. Opening a pull
request is not CI approval, and approving CI is not approval to merge.

Before approving a run, maintainers inspect the complete diff, with particular care around
`.github/workflows/`, install and lifecycle scripts, dependency files, and code executed during the
build. Contributors should expect CI to remain pending until that review is complete. New commits
may require another approval.

The PR workflow deliberately has no secrets, OIDC, deployment environment, write permission,
self-hosted runner, or cache-save path. Production release automation only runs from `main`. The
repository-level controls and the visibility-change procedure are documented in
[CI security](./docs/ci-security.md); those settings are part of the contribution boundary and must
not be relaxed to make a pull request pass.

## Local Checks

Use Bun `1.3.2` and Node `20.20.0` or newer. Install exactly the committed dependency graph:

```bash
bun install --frozen-lockfile
```

Run the CI-equivalent gates before opening a pull request:

```bash
node scripts/check-schema-migration.mjs
bun run db:migrations:check
bun run format:check
bun run boundary:check
bun --bun turbo run lint
bun run typecheck
bun --filter @opencompany/protocol openapi:check
bun run build
bun run build:docs
bun run test
node --test scripts/lib/*.test.mjs
bun run secrets:check
```

TruffleHog must be installed for the local secret scan. The pull request gate scans the exact PR
commit range without repository credentials and reviews new high- or critical-severity dependency
vulnerabilities. `boundary:check` enforces the permanent application and naming boundaries. For
focused development, use Turborepo filters such as `bun run test --filter @opencompany/web`, but run
the full gate before review.

## Schema and Environment Changes

- A change to a database schema file needs a reviewed Drizzle migration unless it is strictly a
  TypeScript-only change with no database effect.
- Never rewrite migration history or run production migrations from a development task.
- New environment variables require `.env.example`, relevant setup and operations documentation,
  the correct hosted secret path, and release preflight coverage.
- Never commit secrets, provider bindings, private URLs, customer data, or generated workspace state.

## Tooling and Review

Biome owns formatting and import ordering. ESLint owns lint rules. Tests use Vitest. Prefer existing
components, helpers, and fixture styles over new abstractions.

External pull requests require the `PR gate`, both CodeQL checks, resolved review conversations, and
one approving review from a maintainer named in [CODEOWNERS](./.github/CODEOWNERS). New reviewable
commits dismiss stale approvals.

The two named maintainers have PR-only review bypass so they can self-merge maintainer-authored work
after every required check passes. GitHub applies bypass permission to the person performing the
merge rather than the pull-request author, so maintainers must not use that bypass to merge an
unreviewed external contribution. The separate status-check, force-push, and deletion ruleset has no
bypass actors.
