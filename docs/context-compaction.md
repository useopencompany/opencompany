# opencompany context compaction

The opencompany engine uses one rolling, lossy checkpoint to keep long chats below the selected
model's context limit. Compaction changes only the derived request sent to the model. The complete
`goat.chat_messages` transcript remains the durable source of record and stays available to the UI
and operators.

## Reference implementations

The v1 design takes the common denominator of four established agent harnesses:

- [Claude Code](https://code.claude.com/docs/en/context-window) automatically replaces older
  conversation with a structured summary near the limit while retaining or re-injecting system
  instructions, project rules, plans, and active skills. Its one-off summary request uses the same
  session prefix plus a final summarization instruction.
- [Codex](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs) triggers from a
  model-specific token limit, emits a continuation summary, rebuilds replacement history, and
  re-injects canonical initial context. Its default
  [checkpoint prompt](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/prompt.md)
  focuses on progress, constraints, remaining work, and critical references.
- [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
  reserves response headroom, selects a recent tail at valid turn boundaries, persists a checkpoint
  plus its retained boundary, and folds the previous summary into later compactions.
- [OpenCode](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/compaction.ts)
  estimates serialized model messages, selects a recent turn tail, carries the previous summary
  into the next pass, and keeps compaction records separate from the original session messages.

The shared proven mechanism is therefore: estimate, reserve headroom, summarize old contiguous
history, retain a recent tail, persist one replaceable checkpoint, and rebuild model context from
the checkpoint plus tail.

## V1 behavior

Before every opencompany model call, the runner estimates tokens for the exact system prompt,
derived messages, and advertised tools. The text estimator assumes two UTF-8 bytes per token, which
is intentionally conservative for ordinary prose and code. Typed image inputs are estimated from
their raster dimensions and the selected model's documented vision rules instead of counting their
base64 transport as text. Compaction starts at 80% of the configured catalog context window, while
always reserving at least 16,384 tokens.

The runner walks backward over whole hydrated user turns and retains up to an estimated
20,000-token recent tail, always keeping the current turn. The exact tail budget is reduced when
the system prompt, advertised tools, and reserved summary need more of the selected model's window.
It asks the selected conversation model for a structured checkpoint of the older segment, capped
at 4,096 output tokens. Oversized history is folded through multiple bounded summary requests;
historical images are included in the request that summarizes their source turn so their visual
evidence can enter the checkpoint. Each batch is limited to 20 images and 16 MiB of encoded image
data. The summary prompt explicitly asks for current objectives, constraints, decisions, unresolved
approvals, exact tool/action IDs, visual evidence, and next steps. System/workflow instructions
remain outside message history and are passed verbatim to the next model call; the current user
request and retained tail also remain verbatim.

`goat.chat_context_compactions` holds one row per chat. On a later pass, the previous checkpoint and
newly aged-out messages are summarized together and the same row is replaced, so summaries cannot
stack without bound. The write is fenced by the active turn lease and happens only after summary
generation and rebuilt-context validation succeed. Failures follow the normal turn error path and
never delete or alter transcript rows.

Successful logs include the checkpoint generation, newly compacted message range, first retained
message ID, model, and before/after estimates. Capacity-failure logs add numeric budget diagnostics.
They do not include summary or transcript content. Every summary request records usage separately,
including successful batches before a later batch fails.

## Deliberate limits

V1 does not prune individual tool results, split a single oversized current turn, recover from
provider overflow errors, provide manual compaction, or retrieve old messages semantically. A
current turn, system prompt, or tool catalog that cannot fit by itself fails with capacity
diagnostics through the normal error path. Image accounting is an estimate; PDF, audio, and video
inputs retain serialized-size accounting.

The pre-mortem's highest-risk failure is dropping live state at the cut boundary. Whole-turn cuts,
verbatim retention of the current turn, explicit identifier-focused summary instructions, a stale
checkpoint fallback to canonical history, and commit-after-validation ordering are the v1 defenses.
