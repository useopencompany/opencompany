# Public repository launch runbook

- Status: Ready
- Last verified: 2026-09-07
- Repository: `useopencompany/opencompany`
- Scope: visibility change only; do not rename the repository

## Purpose

The pre-publication work is complete. The repository owner performs the visibility change. A
maintainer then applies and verifies the two controls that GitHub exposes only for public
repositories, before the launch is announced or an external pull request is accepted.

Keep an authenticated repository administrator present for the whole sequence. If a public-only
control cannot be applied or verified, immediately return the repository to private and investigate
before trying again.

## Before pressing the button

These conditions were verified on 2026-09-07:

- `main` matched its remote and the working tree was clean;
- secret scanning and push protection were enabled, and an independent scan of all live branches
  and pull-request heads found no verified credentials;
- the project license, third-party notices, trademark boundary, contribution terms, security policy,
  code of conduct, and contributor-email decision were resolved;
- external work requires one CODEOWNER approval, while the two maintainers have PR-only review
  bypass for their own work;
- deletion, force-push, and the credential-free `PR gate` have no bypass;
- Actions has read-only default permissions, cannot approve pull requests, permits only selected
  actions, and requires actions to be pinned to a full commit SHA;
- the private-repository fork setting executes no workflow from a fork pull request; and
- production accepts only `main` and does not allow administrator bypass.

## Change visibility

In GitHub, open **Settings → General → Danger Zone → Change repository visibility**, choose
**Public**, and confirm the repository name. Do not rename the repository.

Do not announce the launch yet.

## Apply the public-only controls

Run these commands immediately after GitHub reports the repository as public:

```bash
launch_repo=useopencompany/opencompany

gh api --method PUT \
  "repos/$launch_repo/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors

gh api --method PUT \
  "repos/$launch_repo/private-vulnerability-reporting"
```

GitHub rejects both settings while the repository is private, so they cannot be staged earlier.
`all_external_contributors` means an external contributor's fork workflow remains held until a
maintainer explicitly approves it. No workflow job executes before that approval.

## Verify the live policy

Run:

```bash
launch_repo=useopencompany/opencompany

gh api "repos/$launch_repo" --jq '{visibility,private}'
gh api "repos/$launch_repo/actions/permissions/fork-pr-contributor-approval"
gh api "repos/$launch_repo/private-vulnerability-reporting"
gh api "repos/$launch_repo/rulesets/20982590" \
  --jq '{name,enforcement,bypass_actors,rules}'
gh api "repos/$launch_repo/rulesets/20983115" \
  --jq '{name,enforcement,bypass_actors,rules}'
gh api "repos/$launch_repo/actions/permissions"
gh api "repos/$launch_repo/actions/permissions/workflow"
gh api "repos/$launch_repo/environments/production" \
  --jq '{protected_branches,custom_branch_policies,can_admins_bypass,protection_rules}'
gh api "repos/$launch_repo/environments/production/deployment-branch-policies"
```

Confirm:

- visibility is public;
- fork pull requests require approval for all external contributors;
- private vulnerability reporting is enabled;
- `Protect main` requires only `PR gate` and blocks deletion and non-fast-forward pushes, with no
  bypass actor;
- `Require PR review` requires one CODEOWNER approval and allows PR-only bypass only for the two
  maintainers;
- Actions remains selected-actions-only, full-SHA pinned, read-only by default, and unable to approve
  pull requests; and
- production remains restricted to the exact `main` branch with no administrator bypass.

## Exercise an external-fork canary

Use an account that is not a repository collaborator:

1. Fork the repository and open a pull request containing a harmless documentation-only change.
2. Confirm the workflow is held and no job executes before maintainer approval.
3. Inspect the diff, then approve the workflow run as a maintainer.
4. Confirm the credential-free `PR gate` completes successfully. Default CodeQL not running on the
   fork pull request is expected and is not a merge requirement.
5. Confirm the pull request still reports review required until a CODEOWNER approves it.
6. Close the canary without merging it.

The canary covers the public dependency, migration, documentation-link, secret, and build checks
through the same `PR gate` used by real external contributions.

## Complete or roll back

After every verification and the canary pass, announce the repository and mark PRO-220 complete.

If any step fails, do not weaken the branch, review, Actions, or production rules. Return the
repository to private, record the failed check in PRO-220, and investigate before another attempt.
