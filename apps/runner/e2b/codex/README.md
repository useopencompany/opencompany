# Coding E2B Toolbox Template

This shared Codex and Claude Code chat template extends E2B's `codex` template and bakes in the
runner's repo workflow toolbox:
`rg`, `fd`, `jq`, `curl`, `git`, `gh`, `tmux`, `ss`, Node/npm 22+, Bun `1.4.2`,
`@agentclientprotocol/codex-acp@1.10.0`, `@openai/codex@0.153.4`,
`@anthropic-ai/claude-code@2.1.220`, Playwright `1.60.0`,
Infisical CLI `0.43.118`, Playwright-managed Chromium, and Docker Engine (with the Compose
plugin) for containers inside the sandbox — the sandbox itself is a Linux microVM, so this is a
real `dockerd`, not something like OrbStack (a macOS Docker Desktop replacement) that couldn't
run inside it. The `user` account is added to the `docker` group, so `docker` works without
`sudo`.

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
tmux -V
ss --version
bun --version
node --version
npm --version
codex --version
claude --version
infisical --version
playwright --version
playwright screenshot --browser chromium about:blank /tmp/playwright-chromium-smoke.png
rm -f /tmp/playwright-chromium-smoke.png
docker --version
docker compose version
docker run --rm hello-world
```

## Rollout

Set `OPENCOMPANY_CODEX_E2B_TEMPLATE=opencompany-codex-toolbox` in Infisical for the runner
environment, then redeploy the runner. The variable configures both persistent Codex and Claude Code
Chat sandboxes. Leave it unset to fall back to E2B's `codex` template.
