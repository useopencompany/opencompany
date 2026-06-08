# Incremental Capability Discovery — Research & Design Directions

Status: research / design discussion (2026-06-08). Branch `louismorgner/incremental-capability-discovery`,
intended to merge into the `/personal` experiment (PR #353, `louismorgner/default-personal-agent`).

Goal: let the agent **self-extend on the fly**. While working a task it should be able to notice
"there's a tool/skill for this that I don't have yet" and surface or acquire it — starting with the
tools we opinionatedly ship, growing into an official/recommended skills list over time.

---

## 1. What already exists (and what it does *not* do)

The runtime already has a mature **progressive-disclosure** layer for capabilities it has been
*granted*. It does **not** have a **capability-acquisition** layer for capabilities it has *not*
been granted. These are two different axes that are easy to conflate.

### Axis A — lazy loading of *granted* capabilities (DONE)

- `packages/agent-runtime/src/tools.ts` — `AGENT_TOOL_CATALOG` (≈12 opinionated capabilities:
  exa, x, youtube, tiktok, instagram, amp, opencode, gmail, google_calendar, linear, slack, posthog),
  each mapping to N `RuntimeToolName`s.
- Three-tier model: always-direct core tools (file/shell/`ask_user_question`/`find_tools`/`tool_help`/
  `use_tool`), deferred capability tools, and per-server MCP tools.
- `find_tools` → `tool_help` → `use_tool` (and `{server}__search_tools` / `{server}__use_tool` for MCP).
  This mirrors **Nous Research's Hermes "Tool Search"** (`tool_search` / `tool_describe` / `tool_call`)
  and the **RAG-MCP** result that retrieving a small relevant subset beats dumping every schema.
- System prompt `## Tools` / `## Skills` indices (`config.ts: buildToolsIndexSection`,
  `buildSkillsIndexSection`) list only one-liners, kept cache-stable.

**Critical scoping fact:** `resolveRuntimeToolNamesForConfigTools()` (tools.ts:2133) builds the runtime
tool set **only from `agent.config.tools`** (the `@`-mentions in the body). `find_tools` searches *that
resolved set*. So at runtime the agent can only ever see/expand capabilities **already enabled in its
own definition**. The rest of the catalog is invisible to it.

### Axis B — capability *acquisition* (THE GAP)

- The supply side already exists, but only **UI-side**:
  - Opinionated tools: `SUPPORTED_AGENT_TOOLS` / `AGENT_TOOL_CATALOG`, surfaced as `@`-mention items
    in the editor (`apps/web/components/agent-editor/tools.ts`).
  - External skills: added by pasting a GitHub / skills.sh URL (`@skill` → resolve → snapshot →
    `workspace_skill_snapshots`), see `docs/future-concepts/external-skills-support-research.md`.
  - `/personal` capability panel (`PersonalCapabilityPanel.tsx`) lists enabled tools/skills/integrations.
- The acquisition *mechanism* also exists: the agent can **self-edit its own definition**
  (`agent-self-edit` skill → `update_agent_file`, gated on reading the SKILL.md first) and can
  **author personal skills** (`skill-creator` skill → `agent/skills/<id>/SKILL.md`).
- **What's missing:** nothing tells the agent *what capabilities exist that it hasn't enabled*, nor
  gives it an eligibility-aware way to find them. There is no "shop" — only an "inventory." The agent
  can technically add `@exa` to its body via self-edit, but it has no way to learn `exa` is an option.

So the work is: **a discovery/recommendation layer over the not-yet-enabled catalog, plus a trigger
that makes the agent look there when a task exceeds its current toolset, plus a sensible acquisition path.**

---

## 2. Directions considered

### (A) A discovery **tool call** — `discover_capabilities`
A read-only tool that searches the **full** catalog (opinionated tools + official/recommended skills),
**including not-enabled ones**, and returns for each: id, description, `enabled` flag, eligibility
(`available` vs `needs_setup` with the prerequisite, e.g. "connect Linear" / "EXA_API_KEY missing"),
and `howToEnable` (the `@`-mention to add, or the settings link).

- **Pros:** Fits the repo's grain exactly (sits next to `find_tools`/`tool_help`/`use_tool` — the
  "shop" beside the "inventory"). Live and eligibility-aware (knows which env vars / integrations the
  workspace has). Scales to a large catalog without prompt bloat. Advisory by default — returns *how*
  to enable, doesn't silently grant.
- **Cons:** New runtime tool + dispatcher wiring. Agent only calls it if prompted to (needs the nudge,
  below). Returns a flat list — ranking/relevance matters as the catalog grows (Tool-RAG territory).

### (B) A dedicated **skill** — e.g. `extend-capabilities`
A built-in SKILL.md playbook the agent reads when it senses a gap, documenting *when* and *how* to
self-extend (read the catalog, pick, self-edit or ask). Mirrors the Claude `find-skills` skill present
in this very session.

- **Pros:** On-brand, zero new runtime tool if the catalog is embedded in the SKILL.md. Good home for
  the *judgment* ("when is adding a capability worth it, when do I ask the user").
- **Cons:** A static catalog inside a skill file goes stale and **can't reflect workspace eligibility**
  (which integrations are connected, which env vars exist). Best as a thin *companion* to (A), not the
  data source itself.

### (C) Always-on **thin prompt catalog**
Append a "Capabilities you could add" section (one-liners for not-enabled tools + recommended skills)
to the system prompt.

- **Pros:** Dead simple, no new tool, the agent always "knows" the options.
- **Cons:** Static, grows the prompt as the catalog grows, no eligibility logic, no relevance ranking.
  Doesn't scale to an "official skills list over time." **Use only the one-line *nudge*, not the full list.**

### (D) Out-of-band **recommender** (post-turn / background critic)
A separate pass watches the transcript and, when it detects an unmet need (a failed task, a "wish I
could…", a repeated manual workaround), surfaces a suggestion in the UI ("Your agent tried X — enable
@exa?") or as a `/personal` "Suggested capabilities" section the user accepts.

- **Pros:** Best *user-facing* UX; decouples discovery from the hot path; naturally feeds a "Suggested"
  tab in the capability panel; can learn from many sessions.
- **Cons:** Doesn't help the agent mid-task (it's after the fact); extra infra. **A complement / phase 2,
  not the core agent-facing mechanism.**

---

## 3. Recommended sensible default

A layered design where each piece does one job:

1. **Trigger (nudge), prompt-level — one sentence.** In `buildToolsIndexSection` framing, tell the agent:
   *"Your enabled tools are below. If a task needs a capability you don't have, call
   `discover_capabilities` to see what you can add — don't assume the list below is everything."*
   Cache-stable, ~1 line. This is the "self-tell" trigger; without it the agent never looks.

2. **Discovery — direction (A), `discover_capabilities` tool.** Read-only, eligibility-aware, searches
   the full opinionated catalog + the official-skills manifest, returns `enabled` + `eligibility` +
   `howToEnable`. Honest about setup-gated ones (links to the connect flow rather than pretending it
   can use them).

3. **Acquisition — reuse the existing self-edit path, human-in-the-loop for durable change.**
   - For a durable change, the agent proposes via `ask_user_question` ("I can add @exa to my behavior so
     I can do web research going forward — okay?") then self-edits (`update_agent_file`). Durable change
     to the user's agent should be consented, not silent.
   - For setup-gated capabilities, surface the connect link; don't self-grant.
   - *(Open question: also support session-only/ephemeral enablement so the agent isn't blocked
     mid-task, with a "make this permanent?" follow-up — see decisions below.)*

4. **Supply — start with a small code-shipped official-skills manifest.** Like `AGENT_TOOL_CATALOG`:
   a curated list of recommended skills (name, description, source URL) reusing the existing
   external-skill resolve/snapshot pipeline for acquisition. Grow it over time; later back it by
   skills.sh / a hosted index. Opinionated tools come for free (the catalog already exists).

5. **Phase 2 — direction (D) recommender** feeding a "Suggested" section in the `/personal` capability
   panel, for the user-facing nudge.

**Why this split:** (C-nudge) makes the agent *look*; (A) gives it a *live, honest* place to look that
scales; existing self-edit gives a *safe, consented* way to act; (B) can later carry the *judgment*; (D)
later carries the *user-facing* surface. Tools > a static skill catalog for anything eligibility-aware
and live.

---

## 4. Decisions to confirm before building

1. **Acquisition autonomy:** agent self-edits durably *after asking the user*, or never durably (only
   proposes, user clicks to add in the panel)? Lean: agent proposes via `ask_user_question`, self-edits
   on yes; setup-gated ones always go through the UI connect flow.
2. **Session-only enablement:** support ephemeral "use it just for this task" so the agent isn't blocked,
   or always require the durable self-edit first? Ephemeral is more powerful but adds runtime state.
3. **v1 scope:** tools-only first (the opinionated catalog), skills in a follow-up — matches "start with
   the tools we opinionatedly add"? Lean: yes.
4. **Discovery shape:** a new `discover_capabilities` tool, or widen `find_tools` with an
   `includeAvailable: true` mode? Lean: new tool — `find_tools` is "what can I run *now*", discovery is
   "what could I add" — keeping them separate keeps each prompt-clear.
5. **Official-skills supply:** code-shipped manifest now (simple, reviewable), skills.sh-backed index later?
