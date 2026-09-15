# Coding E2B Toolbox Template

This shared Codex and Claude Code chat template extends E2B's `codex` template and bakes in the
runner's repo workflow toolbox:
`rg`, `fd`, `jq`, `curl`, `git`, `gh`, `tmux`, `ss`, `lsof`, `ffmpeg`, `ffprobe`, Node/npm 22+,
Bun `1.4.2`,
`@agentclientprotocol/codex-acp@1.10.0`, `@openai/codex@0.153.4`,
`@anthropic-ai/claude-code@2.1.220`, Playwright `1.60.0`,
Doppler CLI `3.76.5`, Infisical CLI `0.43.118`, Playwright-managed Chromium, and Docker Engine (with the Compose
plugin) for containers inside the sandbox — the sandbox itself is a Linux microVM, so this is a
real `dockerd`, not something like OrbStack (a macOS Docker Desktop replacement) that couldn't
run inside it. The `user` account is added to the `docker` group, so `docker` works without
`sudo`.

## Machine sizes

E2B fixes vCPU and RAM when a template is built — `Sandbox.create` takes no per-sandbox
resource override — so each user-selectable machine size is its own alias built from this
one image definition:

| Size | Alias | Allocation |
| -- | -- | -- |
| Small | `opencompany-codex-toolbox-small` | 2 vCPU / 4096 MB |
| Standard | `opencompany-codex-toolbox-standard` | 4 vCPU / 8192 MB |
| Large | `opencompany-codex-toolbox-large` | 8 vCPU / 16384 MB |

The sizes come from `SANDBOX_SIZE_SPECS` in `@opencompany/core/sandbox-sizes`, which is also
what the workspace setting and the size labels in the app read. Workspace admins pick the
default in Settings → Sandboxes; a session pins the size it was created with.

Billing already meters the CPU and RAM E2B reports for the live sandbox, so a smaller size
bills less with no billing change.

## Build

Run the build with an E2B API key. It builds every size in sequence from the same image:

```sh
E2B_API_KEY=e2b_... bun apps/runner/e2b/codex/build.prod.ts
```

## Pause/resume soak test (release gate)

The old single 16 GB allocation was deliberate headroom: sandboxes paused near their memory
ceiling produced snapshots that wedged on resume (prod incident 2026-09-08/09). Every size has
to be proven against that failure before it is offered, so run the soak after building and
before pointing the runner env at the new aliases:

```sh
E2B_API_KEY=e2b_... bun apps/runner/e2b/codex/soak.pause-resume.ts
```

It starts a headless Chromium, then pins 85% of whatever memory is still free — taken from
`MemAvailable`, so every size ends up under the same pressure — and pause/resumes the sandbox
five times. After each resume it checks that the guest answers the same probe `connectSandbox`
uses and that both loads survived the restore, since a guest that answers after the kernel
reaped its workload proves nothing. `SOAK_CYCLES` and `SOAK_MEMORY_OCCUPANCY` override the
defaults, and passing size names limits the run to those sizes. A failing size must not be
configured in the runner environment.

## Smoke Test

After building, spawn the template and verify the expected tools:

```sh
e2b sandbox spawn opencompany-codex-toolbox-standard
rg --version
fd --version
jq --version
gh --version
ffmpeg -version
ffprobe -version
tmux -V
ss --version
lsof -v
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

After the build and a passing soak, set all three aliases in Infisical (`prod` `/runner`). They
are declared on the `opencompany-runner` service in `render.yaml` with `sync: false`, so Render
takes them from the environment group rather than the blueprint:

```
OPENCOMPANY_CODEX_E2B_TEMPLATE_SMALL=opencompany-codex-toolbox-small
OPENCOMPANY_CODEX_E2B_TEMPLATE_STANDARD=opencompany-codex-toolbox-standard
OPENCOMPANY_CODEX_E2B_TEMPLATE_LARGE=opencompany-codex-toolbox-large
```

Then redeploy the runner. The release preflight requires all three, so a partial sync fails the
release instead of quietly spawning a workspace onto a machine it did not choose. They configure
both persistent Codex and Claude Code Chat sandboxes. Each unset alias falls back to E2B's stock
`codex` template, which is fine locally but makes every size the same machine.

Add the three without removing the retired `OPENCOMPANY_CODEX_E2B_TEMPLATE`: the currently deployed
runner still reads it, and leaving it in place keeps a rollback on the old image working. Delete it
once the new runner is live and you no longer intend to roll back.

When the runner already uses these aliases, rebuilding them updates newly created sandboxes without
a runner redeploy. Existing persistent sandboxes retain their filesystem and installed tools when
resumed; template updates do not retrofit them.

## Doppler verification

Run `bun apps/runner/e2b/codex/smoke.doppler.ts /path/to/doppler` against the pinned binary.
It exercises native headless login, token restoration, two directory configs, and two worktrees
using a local provider fixture with synthetic values. It does not authorize a real account.

The product connection additionally needs a browser check of sign-in, cancellation, and reconnect.
Build candidates with a separate template tag and verify each size before promoting the default tag.
