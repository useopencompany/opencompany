# Past session access

Preferences → Beta features → **Past session access** is an opt-in, per-user flag, off by default.
It adds the `session_history` source to shared action discovery for private chats across the
opencompany, Codex, and Claude Code engines. Switching it off removes discovery and rejects
already-resolved action execution. The host rechecks the current user, workspace membership,
conversation, and flag, and each read query repeats those checks.

- `session_history.find_sessions`: date-filtered discovery (up to 50 results), with optional
  literal, case-insensitive phrase search across titles and user/assistant text. Dates refer to
  message activity, so a chat created earlier can match work done last week. Results include
  excerpts, matching-message counts, timestamps, links, and a continuation cursor.
- `session_history.read_sessions`: read up to 20 sessions per call, with a separate continuation
  cursor for each. Each session page contains at most 30 messages and 11,000 serialized characters;
  an individual message fragment contains at most 8,000 Unicode code points. Cursors can continue
  inside oversized messages and reject a changed or deleted boundary message. Escaping and metadata
  count against the response budget, preserving cursors through the action executor.

Both actions default to the last seven days. Pass explicit ISO timestamps with offsets for calendar
weeks in the user's timezone: `from` is inclusive and `until` exclusive. Each range may cover up to
93 days. Reuse the returned date range and cursor on subsequent reads. Pages exclude newly created
messages beyond the upper bound, but are not immutable snapshots: edits and deletions remain live.

Only the acting user's chats with an explicit runtime association to the active workspace are
eligible. Archived chats remain readable. The current chat, tasks, public shares, and legacy chats
without a verified workspace are excluded. The calling conversation must itself be private and
open; headless action policy also removes the source. Knowledge learned through this feature can
appear in the calling chat, so subsequent sharing of that chat shares its visible content as usual.

Output contains stored user/assistant text and tool-call counts, not hidden reasoning, internal
prompts, raw tool inputs/results, attachments, or subagent transcripts. Tool-call counts reflect the
stored `toolCalls` array and may be zero for historical formats. Transcript content is untrusted
historical evidence, never current instructions or authorization to change skills.

For a weekly skills review, find the period's chats, read relevant sessions in batches, append
unfinished reads to the next batch, and cite session links/message IDs when proposing changes.
The shared 16-action limit still applies. An agent must state incomplete coverage when it cannot
finish and preserve the remaining session IDs, range, and cursors for continuation. Enabling this
flag does not automatically read history or edit skills.

The migration adds a default-false boolean only. Apply it before deploying the application code.
Application rollback can leave the unused column in place; dropping it would discard user opt-ins.
No transcript backfill or search index is required for this first version.
