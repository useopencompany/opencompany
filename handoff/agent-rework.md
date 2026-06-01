# Agent Rework: Folder-Backed Agent Bundles

**Status:** Plan — execute steps top to bottom, one at a time.
**Scope note:** MVP. **No legacy support.** Agents are *always* folder bundles. There is no feature flag,
no `agents/{slug}.agent` single-file fallback, no migration path, and no "legacy vs bundle" branching.
The single-file format is replaced outright.

---

## Goal

Each agent becomes a folder bundle in the GitHub-backed workspace repo:

```
agents/
  sales/
    agent.agent      # the agent definition (instructions)
    memory.md        # durable private memory — always present, writable by default
    sessions.md      # rolling session notes
    playbooks/  examples/  templates/   # advanced, optional (later step)
brain/               # shared company context ONLY
```

Runtime shape inside the E2B sandbox:

```
./agent/   # the current agent's bundle — writable by default (memory.md always exists)
./brain/   # explicitly-mounted shared Brain refs (unchanged, still via @brain/...)
./work/    # ephemeral scratch + cloned repos (unchanged)
```

**Rules of the model:**
- `./agent` = mine: private, writable, on by default, no mention required.
- `./brain` = ours: shared company knowledge, explicit/mention-gated, unchanged.
- `./work` = ephemeral.
- Durable memory default target is `agent/memory.md` (was `@brain/memory.md`).
- An agent only ever sees its **own** bundle. Delegation exposes another agent's *instructions* only,
  never its memory — this falls out of the architecture for free (see Step 4 isolation note).

### Key facts that shape the work (verified)
- `agents.path` stores the `.agent` **file** path and is UNIQUE per workspace (`agents_workspace_path_idx`).
  We keep `path` pointing at the file (`agents/{slug}/agent.agent`) to minimize churn; the bundle dir is
  always `dirname(path)`.
- `agentMentionIdForPath` (`packages/agent-runtime/src/mentions.ts`) derives the `@agent/{slug}` mention
  from the path — must be updated for the new shape, this is the highest-leverage correctness point
  (delegation + `@agent/...` both flow through it).
- `listWorkspaceAgentFiles` already accepts `agents/**/*.agent`, so `agents/sales/agent.agent` is
  discovered on GitHub re-import with no change. `memory.md`/`sessions.md` end in `.md` and are correctly
  ignored as agent files.
- The Brain sync pipeline (`apps/runner/src/brain.ts`) is prefix-agnostic except for three hardcoded
  `brain/` strings. Bundle files are just repo paths under `agents/{slug}/`, so the machinery is reusable.

---

## Step 1 — Path & slug helpers (agent-runtime)

**Goal:** Agents are created and addressed as `agents/{slug}/agent.agent`.

**Changes**
- `packages/agent-runtime/src/agent-file.ts`
  - `agentPathForSlug(slug)` → return `agents/${slug}/agent.agent` (was `agents/${slug}.agent`).
  - Audit `normalizeAgentPath` / serialize / parse for any assumption that the path is `agents/<x>.agent`
    directly under `agents/`. Add `agentBundleDir(path)` = `dirname(path)` helper for downstream use.
- `packages/agent-runtime/src/mentions.ts`
  - `agentMentionIdForPath`: derive slug from `agents/{slug}/agent.agent` → mention `agent/{slug}`
    (the directory name, NOT a naive strip-`.agent` which would yield `agent/{slug}/agent`).
  - `normalizeAgentPath` (mentions side): a bare `@agent/{slug}` resolves to `agents/{slug}/agent.agent`.
- `apps/web/lib/agents/paths.ts`
  - `resolveAgentPath`: collision candidates become `agents/${slug}/agent.agent`,
    `agents/${slug}-2/agent.agent`, … (uniqueness still holds on the file path).

**Acceptance**
- Creating an agent titled "Sales" writes `agents/sales/agent.agent`.
- `@agent/sales` in another agent's body resolves to that agent; delegation lookup
  (`eq(agents.path, ...)`) succeeds.
- Unit tests: mention-id round-trip for several slugs incl. collisions (`-2`), and delegation reference
  resolution.

---

## Step 2 — DB schema for agent bundle files

**Goal:** A place to store per-agent bundle files, namespaced and owned by the agent.

**Changes** — `packages/db/src/schema.ts` (+ generated migration)
- `agentFiles` — clone of `brainFiles`, plus `agentId` FK (`ON DELETE CASCADE`). Columns:
  `id, workspaceId, agentId, path (full repo path e.g. agents/sales/memory.md), content, contentHash,
  sizeBytes, githubBlobSha, githubCommitSha, githubSyncStatus, githubSyncError, githubSyncedAt, ...`.
  Unique index on `(workspaceId, path)`.
- `agentSessionBundleMounts` — clone of `agentSessionBrainMounts` (`sessionId, workspaceId, path,
  baseHash, lastSyncedHash, status, ...`) for conflict detection.
- `agentFileSyncJobs` — clone of `brainSyncJobs` for async GitHub retry (`workspaceId, path, operation,
  desiredHash, nextRunAt, status, attempts, ...`).

**Acceptance**
- Migration applies cleanly. Deleting an agent cascades its `agentFiles` rows.

---

## Step 3 — Factor a prefix-agnostic repo-file sync core

**Goal:** Reuse the exact Brain sync algorithm for bundle files without duplicating it; no behavior change
to Brain.

**Changes**
- New `apps/runner/src/repo-files.ts`: extract from `apps/runner/src/brain.ts` the prefix-agnostic pieces:
  `writeRepoFileToGitHub(path, content)`, `deleteRepoFileFromGitHub(path)`, `conflictPath(path)`, content
  hashing, and the async-retry queue helpers — all taking the full repo path (no hardcoded `brain/`).
- Rewire `brain.ts` to call the core via thin `brain/`-prefixed wrappers. Keep its public functions and
  behavior identical.

**Acceptance**
- Existing Brain materialize/sync tests still pass unchanged.

---

## Step 4 — Mount `./agent` bundle in the sandbox

**Goal:** Every session mounts the agent's own bundle at `./agent`, writable, with `memory.md` guaranteed
to exist.

**Changes**
- `apps/runner/src/sandbox.ts`
  - `sandboxLayout`: add `agentRoot: ${workdir}/agent`.
  - `prepareWorkspace`: `mkdir -p` the `agentRoot` and `chown user:user` (writable by default).
  - `resolveSandboxToolPath`: add `agent` / `agent/...` to the allow-list; update the two
    "Path must be inside work/ or brain/…" error strings to include `agent/`.
- `packages/agent-runtime/src/paths.ts` `resolveWorkspacePath`: allow the `agent/` prefix.
- New `apps/runner/src/agent-bundle.ts`
  - `materializeAgentBundleForSession({ sandbox, sessionId, workspaceId, agentId, workdir })`: load
    `agentFiles` rows for this `agentId`, strip the `agents/{slug}/` prefix, write into `agentRoot`
    preserving relative structure (`agents/sales/memory.md` → `./agent/memory.md`,
    `agents/sales/playbooks/x.md` → `./agent/playbooks/x.md`). **Always ensure `./agent/memory.md` exists**
    (create empty if absent). Record `agentSessionBundleMounts` (baseHash/lastSyncedHash).
  - `syncAgentBundleFromSandbox(...)`: mirror of `syncBrainFromSandbox` — read changed files under
    `./agent`, re-prefix back to `agents/{slug}/...`, upsert `agentFiles`, write to GitHub via the Step 3
    core, conflict copies, async retry via `agentFileSyncJobs`. Defensive guard: the resolved repo path
    must `startsWith(bundleDir + "/")`.
- `apps/runner/src/session-lifecycle.ts` `ensureSandbox`: after `materializeBrainForSession`, call
  `materializeAgentBundleForSession`.
- `apps/runner/src/agent-loop.ts`: call `syncAgentBundleFromSandbox` in both run paths (after the existing
  `sync_brain_after_message` and `sync_brain_after_session` points).

**Isolation note (no extra work, just don't regress):** only this `agentId`'s files are ever written into
`./agent`; tools are confined to `work/ | brain/ | agent/`. Other agents' bundles are never materialized
into the sandbox, so there is no path to read them. Delegation already loads only the target's
`config.instructions` and runs the child in its own sandbox with its own bundle.

**Acceptance**
- Start a session for agent "sales": `./agent/memory.md` exists and is writable.
- Write to `agent/memory.md` during the turn → after session it appears in `agentFiles` and on GitHub at
  `agents/sales/memory.md`. A second session sees the updated content mounted.
- Writing to `work/` and `brain/` still works; bare paths still rejected.

---

## Step 5 — System prompt + after-session default → `agent/memory.md`

**Goal:** The model is told about `./agent`, and durable memory defaults to `agent/memory.md`.

**Changes**
- `packages/agent-runtime/src/config.ts` `resolveAgentRuntimeConfig`:
  - Describe three writable roots: `./work`, `./brain`, `./agent`.
  - Add: "Your durable memory lives in `agent/memory.md` (private to you), writable by default. `./brain`
    is shared company context; edit it only via mounted `@brain/...` refs."
  - Update the file-tools line to list `work/`, `brain/`, `agent/` prefixes.
- `apps/runner/src/agent-loop.ts`: change the after-session system-prompt suffix to instruct capturing
  durable learnings in `agent/memory.md` (use `./brain` only for shared knowledge).
- Update default agent templates / seed bodies: any `#after-session` text that says `@brain/memory.md` →
  `agent/memory.md`. (Grep seed/template content for `@brain/memory.md`.) `extractAfterSessionConfig`
  needs no change.

**Acceptance**
- A fresh agent with the default after-session prompt writes to `agent/memory.md` (not Brain) and it
  persists to GitHub under the bundle.

---

## Step 6 — Rename moves the whole bundle folder

**Goal:** Changing an agent's title moves `agents/{old}/ → agents/{new}/`, memory included.

**Changes**
- `apps/web/lib/agents/actions.ts` `updateAgent` + `apps/web/lib/agents/sync-job.ts`
  `resolveAgentSyncRename`: on title change, compute the new bundle path and record the old path as today,
  but extend so the sync worker moves *all* bundle files (`memory.md`, `sessions.md`, `playbooks/**`),
  not just `agent.agent`.
- Re-key `agentFiles` rows from the old `agents/{old}/` prefix to `agents/{new}/` and enqueue GitHub moves
  via `agentFileSyncJobs` (write-new + delete-old, conflict-safe — worst case lands at a conflict path,
  never lost).
- `apps/web/lib/agents/materialize.ts` / sync worker: handle the multi-file move.

**Acceptance**
- Rename "Sales" → "Revenue": GitHub shows `agents/revenue/agent.agent` + `agents/revenue/memory.md`,
  `agents/sales/` is gone, and `@agent/revenue` resolves. Memory content is preserved.

---

## Step 7 (optional, later) — Full bundle tree + web UI

**Goal:** Support `playbooks/`, `examples/`, `templates/` and surface bundle files in the app.

**Changes**
- `materializeAgentBundleForSession` / `syncAgentBundleFromSandbox`: handle the whole tree with
  brain-equivalent size/count limits (mirror `MAX_BRAIN_FILE_BYTES`, `MAX_BRAIN_MOUNT_FILES`, etc.).
- Web Agent detail UI: list/edit bundle files, reusing the Brain file viewing patterns.

**Acceptance**
- An agent can read/write nested bundle files; they round-trip to GitHub and back into the next session.

---

## Risks / watch-items
- `agentMentionIdForPath` correctness for the new path shape (Step 1) — breaks delegation if wrong.
- Confirm GitHub re-import via `listWorkspaceAgentFiles` computes the same mention id and the
  `(workspaceId, path)` unique index prevents duplicate agents.
- Folder-move-on-rename (Step 6) is the riskiest mechanic — keep it async + conflict-safe.

## Suggested execution order
Steps 1 → 5 deliver the core UX (folder agents + always-on private memory). Step 6 (rename) and Step 7
(full bundle + UI) can follow once the core is verified.
