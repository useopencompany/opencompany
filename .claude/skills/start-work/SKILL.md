---
name: start-work
description: Bootstrap a fresh work session on this repo — branch sanity, deps, per-branch Neon DB, migrations. Splits interactive vs non-interactive work cleanly so the agent does what it can and hands off the rest with exact commands. Use when the user says "start work", "kick off", "begin", "set me up", or opens a new workspace.
---

# Start work

This skill is **agent-driven** and **honest about handoffs**. It does what it can without a TTY, and explicitly stops for the human-only parts (browser OAuth, WorkOS dashboard input) with copy-pasteable commands.

## How to run

### 1. Git branch sanity

```bash
git branch --show-current
```

- If on `main`: stop and ask the user what feature branch to create. Suggested format: `<username>/<short-description>`. Then `git checkout -b <branch>`.
- Otherwise: continue.

### 2. Dependencies

If `node_modules/` is missing, run `bun install`. Non-interactive, safe to run.

### 3. Inspect state

```bash
bun run setup -- --check
```

This emits a JSON object with the current state of `.env.local`, WorkOS keys, Neon auth, and DATABASE_URL, plus a `nextSteps` array. Parse it and decide what to do.

### 4. Act on state

For each entry in `nextSteps`, follow this table:

| Reason | Who does it | What to do |
|---|---|---|
| `create .env.local` | agent | Run `bun run setup` *only if* you can confirm no interactive prompts will fire (i.e. WorkOS already configured upstream). Otherwise treat like next row. |
| `provision WorkOS via bunx workos@latest install (interactive)` | **user** | Stop. Tell the user to run `bun run setup` in their terminal — it will offer to launch the WorkOS installer, which auto-provisions a temporary dev environment and writes keys to `.env.local`. No WorkOS account needed for first try. |
| `browser login to Neon (interactive)` | **user** | Stop. Tell the user to run `bunx neonctl auth` in their terminal (opens browser). If multi-project, also `bunx neonctl set-context --project-id <id>`. |
| `create per-branch DB and apply migrations (non-interactive, safe for agent)` | agent | Run `bun run db:branch:create && bun run db:migrate`. Both are non-interactive. |

If `nextSteps` is empty, everything is ready.

### 5. Confirm and stop

When the agent-doable steps are done, summarize:

- Current git branch
- Neon branch name (re-read `.env.local`)
- Any remaining user-only steps with exact commands
- The exact next command: `bun run dev`

Do NOT start the dev server. The user's global instructions say they always have one running.

## Decision rule

When in doubt: **run it if it has no prompts and no browser, otherwise hand off**. A clean hand-off with the right command is better DX than a hung Bash call.

## Don't

- Don't pipe input to `bun run setup` to skip prompts. The prompts gate WorkOS and Neon flows that genuinely need a human.
- Don't modify `.env.local` directly — let `scripts/setup.mjs` and `scripts/neon-branch.mjs` own it.
- Don't create a Neon branch via `neonctl` directly. Use `bun run db:branch:create` so `.env.local` stays in sync.
- Don't run `bunx workos@latest install` yourself in Bash — the installer is interactive and assumes a real terminal.
