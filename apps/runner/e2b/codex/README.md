# Codex E2B Toolbox Template

This template extends E2B's `codex` template and bakes in the runner's repo workflow toolbox:
`rg`, `fd`, `jq`, `curl`, `git`, `gh`, Node/npm 22+, Bun `1.3.2`,
`@openai/codex@0.144.6`, `@anthropic-ai/claude-code@2.1.220`, Playwright `1.60.0`,
and Playwright-managed Chromium.

## Build

Run the build with an E2B API key:

```sh
E2B_API_KEY=e2b_... bun apps/runner/e2b/codex/build.prod.ts
```

The production alias is `opencompany-codex-toolbox`. The build must use 8 vCPU and 8192 MB RAM to
match the runner's Codex sandbox billing allocation.

## Smoke Test

After building, spawn the template and verify the expected tools:

```sh
e2b sandbox spawn opencompany-codex-toolbox
rg --version
fd --version
jq --version
gh --version
bun --version
node --version
npm --version
codex --version
claude --version
playwright --version
playwright screenshot --browser chromium about:blank /tmp/playwright-chromium-smoke.png
rm -f /tmp/playwright-chromium-smoke.png
```

## Rollout

Set `OPENCOMPANY_CODEX_E2B_TEMPLATE=opencompany-codex-toolbox` in Infisical for the runner
environment, then redeploy the runner. Leave the variable unset to fall back to E2B's `codex`
template.
