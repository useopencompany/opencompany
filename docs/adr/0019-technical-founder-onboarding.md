# ADR 0019: Technical Founder Onboarding

- Status: Accepted
- Date: 2026-09-24

## Context

A new workspace started empty. The only thing created was the Company Wiki, and home opened on a
blank "What should we build next?". Founders asked for useful defaults in the first minute. We are
focusing on technical founders first: people who pick "Founder / CEO" or "Product / Engineering"
during onboarding.

## Decision

For those two roles, the onboarding plugins step becomes **Connect your code**. Every other role
keeps the plugin catalog step. The owner flow stays at five steps.

1. **Connect GitHub.** The founder connects the "GitHub as you" plugin through the existing popup
   flow.
2. **Read the repository.** `POST /v1/onboarding/repository-scan` picks the member's most recently
   pushed, non-archived repository, or the one they choose.
   - Access is checked against their own installations, so a repository name that isn't theirs
     reads as missing.
   - The scan reads only setup files, from `readGitHubUserRepositorySetupFiles`: dependency
     manifests up to three directories deep (`package.json`, `requirements*.txt`, `pyproject.toml`,
     `go.mod`, `Gemfile`, `composer.json`) and env templates (`.env.example` and similar). It never
     reads source code or `.env` files.
3. **Suggest plugins.** `packages/agent/src/repository-plugin-scan.ts` reduces those files to
   evidence:
   - dependency names per manifest;
   - config file paths;
   - the variable *names* in env templates. Values are discarded.

   The `typesafe-ai/jev` evaluation model answers one yes/no question per plugin that can be
   detected. A plugin is suggested at a probability of 0.8 or more.
   - A fixed signal table supplies the reason shown to the user (for example
     `posthog-node in package.json`).
   - The same table decides on its own when the model is unavailable, because Jev returned 503s
     during development.
   - Linear, Slack, and Gmail are always suggested for the team.
4. **Review permissions before connecting.** Every onboarding connection first opens a dialog. It
   shows the provider's default On / Ask / Off modes from `PROVIDER_CAPABILITIES`, explains what each
   mode means, and states that opencompany enforces them. The OAuth popup opens only from the
   dialog's confirm click.
   - Plugins that connect with an API key (Render, Convex, Infisical) are installed during setup.
     Their key is added from Plugins once onboarding is finished, because the plugin pages are not
     reachable before then.
5. **Start with two workflows.** Finishing onboarding creates the company workflows **Build** and
   **Review PR**:
   - They are active and run only when invoked manually, as `#build` and `#review-pr`.
   - Their instructions name the scanned repository.
   - Neither ever merges, and Review PR never approves.
   - Creation is idempotent by name. A failure is shown to the user but does not block onboarding.

   The ready screen lists the workflows and the plugins that were added, with their connection
   state.

## Consequences

- The scan needs no new secret. The API reuses `VERCEL_AI_GATEWAY_API_KEY`. Without it, and
  whenever Jev fails, suggestions come from the fixed signals.
- Dependency names, config paths, and env variable names from the founder's repository are sent to
  the gateway model. File contents and env values are never sent.
- Suggestions are limited to official plugins that can be connected today. Vercel is excluded until
  its connection is approved.
- A scan costs one installations page per GitHub App installation, one repository tree, at most 30
  small file reads, and one model call. It is rate-limited to 20 per member per window.

## Follow-ups

- An engineering company agent that reads production logs every few hours and opens pull requests
  for likely errors. It was left out of the first version to keep onboarding to two concepts.
- Setups for other roles. Go-to-market and operator founders would read their inbox and calendar
  instead of a repository.
