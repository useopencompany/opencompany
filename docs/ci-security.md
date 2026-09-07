# CI security

This document records the trust boundary for GitHub Actions and the repository settings that are
not represented in workflow YAML. Review it before changing repository visibility, Actions
settings, or pull-request triggers.

## Decision

Use [GitHub's native fork-workflow approval
gate](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks) and
require approval for **all outside contributors**. Do not build a privileged `pull_request_target`
dispatcher or a custom approval bot. Repository collaborators and trusted automation are the
initial allowlist when they have write access; everyone else can open a pull request, but their code
cannot execute in CI until a maintainer approves the specific workflow run after reviewing its diff.

This is the smallest launch setup that preserves a clear maintainer decision for every untrusted
run. GitHub does not provide a repository setting that limits who can open a pull request on a
public repository, so the enforceable boundary is who may execute repository code in Actions.

## Survey

Reviewed on 2026-09-04:

- [Twenty](https://github.com/twentyhq/twenty/blob/main/.github/workflows/external-contributor-pr-auto-draft.yaml)
  identifies outside contributors by author association and routes them through separate,
  base-controlled automation. That works for a mature project with dedicated automation, but adds
  a privileged `pull_request_target` path and another repository to secure.
- [Langfuse](https://github.com/langfuse/langfuse/blob/main/.github/workflows/ci.yml.template) runs
  ordinary `pull_request` CI and relies on GitHub's fork isolation for unavailable secrets.
- [Documenso](https://github.com/documenso/documenso/blob/main/.github/workflows/ci.yml) also runs its
  build directly for pull requests. This is contributor-friendly, but an unrestricted run is wider
  than the initial opencompany launch policy.

GitHub's native approval gate provides the desired early-stage boundary without copying the more
complex automation. If contribution volume later makes per-run approval burdensome, maintainers can
revisit the policy separately after designing a credential-free, cache-safe public CI tier.

## Enforced workflow boundary

`.github/workflows/ci.yml` is the only pull-request entry point and uses `pull_request`, never
`pull_request_target` or `workflow_run`. It and `.github/workflows/verify.yml` enforce:

- no secrets, OIDC, deployment permissions, or GitHub write permissions;
- no production environment or self-hosted runner;
- `persist-credentials: false` on every checkout;
- cache restore for PRs, with cache save restricted to trusted `main` release runs;
- third-party actions pinned to full commit SHAs; and
- a single required `PR gate` result that fails unless every verification job succeeds.

GitHub's default CodeQL setup separately scans trusted pull requests and the default branch. It is
not a required merge check because [default setup excludes pull requests from
forks](https://docs.github.com/en/code-security/concepts/code-scanning/setup-types). Requiring its
check contexts would leave an approved external pull request blocked on checks that GitHub never
creates.

`.github/workflows/release-production.yml` is a separate trusted path. It only accepts `push` to
`main` or `workflow_dispatch`, verifies the selected commit before the privileged job, and scopes
deployment/OIDC permission to the production release job.

## Review and production policy

The live `main` policy was verified on 2026-09-07 and is split across two active rulesets so review
speed does not weaken repository integrity:

- `Protect main` blocks branch deletion and force pushes and requires an up-to-date `PR gate`. It
  has no bypass actors.
- `Require PR review` requires one approving CODEOWNER review, dismisses stale approvals after new
  commits, and requires review conversations to be resolved. `louismorgner` and `MonsterDeveloper`
  are its only bypass actors, both in PR-only mode.
- The opencompany GitHub App is not a separate bypass actor. Its current user access tokens act as
  the connected GitHub user, so agent work inherits that user's repository access and review bypass.

PR-only bypass preserves a pull-request and audit trail, but GitHub evaluates it against the actor
performing the merge rather than the pull-request author. The project policy therefore limits bypass
use to maintainer-authored work; an external contribution must receive one CODEOWNER approval.

[PR #1620](https://github.com/useopencompany/opencompany-experimental/pull/1620) verified the
app-backed `louismorgner` path end to end: GitHub reported `REVIEW_REQUIRED`, the exact head passed
the then-required checks, and the PR merged with zero reviews through the configured bypass. GitHub
CLI requires `--admin` to select that bypass explicitly. Maintainers may use it only after verifying
the exact head and the required `PR gate`, and never for an external contribution.

Repository web-editor commit sign-off is disabled. That matches the approved inbound-equals-outbound
contribution terms and the explicit decision not to require DCO sign-off.

The production environment has no redundant manual reviewer. It accepts deployments only from
`main`, and administrators cannot bypass that branch policy. Production remains automatic after a
permitted merge because the release workflow independently verifies the selected `main` commit
before the privileged deployment job receives OIDC or environment secrets.

## Repository settings contract

The repository owner must keep these settings in **Settings → Actions → General**:

| Setting | Required value |
| --- | --- |
| Actions permissions | Only the actions listed below |
| Require actions pinned to a full-length commit SHA | Enabled |
| Default workflow permissions | Read repository contents |
| Allow GitHub Actions to create and approve pull requests | Disabled |
| Private fork runs | Disabled; if enabled later, require approval and keep write tokens and secrets disabled |
| Public fork contributor approval | Require approval for all outside collaborators |

The selected external actions are `actions/checkout`, `actions/dependency-review-action`,
`actions/cache`, `github/codeql-action`, `oven-sh/setup-bun`, `Infisical/secrets-action`, and
`trufflesecurity/trufflehog`. Remove entries when their last workflow use is deleted. Adding an
action requires a security review, a full-SHA workflow reference, and a settings update.

The private and public fork controls are different GitHub settings. The organization currently
forbids private fork workflow runs, so the repository fails closed: fork code cannot run at all. If
an organization administrator enables private fork workflows later, require approval and never send
write tokens or secrets. As the final visibility-change operation, an administrator must immediately
set the public fork contributor approval policy to `all_external_contributors`; GitHub rejects that
setting while the repository is private.

The public setting can be applied and verified with an administrator token after the repository is
public:

```bash
gh api --method PUT \
  repos/useopencompany/opencompany-experimental/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_contributors

gh api \
  repos/useopencompany/opencompany-experimental/actions/permissions/fork-pr-contributor-approval
```

The returned `approval_policy` must be `all_external_contributors`. Treat a visibility change as
incomplete until that verification succeeds. Do not make the repository public from an unattended
script or as part of an unrelated change.

## Maintainer approval procedure

For a held fork run, open the pull request's **Files changed** view and inspect the proposed commit,
especially workflow, dependency, install-script, and build-script changes. Use **Approve workflows
to run** only when executing that commit under the credential-free PR boundary is acceptable. Do
not add secrets, write permissions, production environments, or privileged follow-up triggers to
make an external run work.
