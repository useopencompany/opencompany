# Chat artifacts

Chat artifacts are durable, user-visible files attached to a conversation. They are distinct from
message attachments: attachments are user inputs, while artifacts are finished outputs published by
an agent.

## Storage model

`goat.chat_artifacts` stores the stable logical identity, owner, conversation, title, description,
and current version. `goat.chat_artifact_versions` stores immutable version metadata and a private
Vercel Blob pathname. Revisions never mutate earlier bytes. Publishing with an `artifact_id` requires
the caller's current `expected_version`; a stale value fails instead of overwriting a concurrent
revision.

Artifacts are scoped to the originating workspace, user, and conversation. Downloads and version
metadata are authorized against all three. Deleting an artifact tombstones its transcript cards and
removes every private blob; it does not expose storage paths to clients.

## Engine contracts

Cloud coding engines (Codex and Claude Code) use `publish_artifact`. The tool reads a file from the
engine sandbox and accepts:

- `path` (required): a file inside the chat working directory
- `title` and `description` (optional display metadata)
- `artifact_id` plus `expected_version` when publishing a revision

The opencompany engine has no sandbox or filesystem. It uses the host-side `write_artifact` tool with
in-band content:

- `filename`, `title`, and complete `content` (required)
- `description` (optional)
- `artifact_id` plus `expected_version` when publishing a revision

`write_artifact` currently accepts Markdown (`.md`) only. Every edit is a complete-content rewrite
that creates version N+1. The host validates the active turn and principal, uploads private bytes,
and atomically advances the logical artifact. If database persistence fails, the new blob is removed.

Managed capabilities such as image generation can also return the same `PublishedChatArtifact`
shape. All successful paths add a `data-artifact-file` part to the assistant transcript and emit an
`artifact.published` run event.

## Limits and supported files

All engines share these hard limits:

- 20 MB per artifact version
- 5 published versions/files per turn
- one immutable version per successful tool-call id (idempotent replay)

Sandbox publishing supports Markdown, plain text, CSV, TSV, JSON, SRT, PDF, DOCX, XLSX, PPTX, PNG,
JPEG, and WebP. The opencompany in-band tool supports Markdown only.

## Viewer and HTTP API

Clicking an artifact card opens the right-side artifact viewer. In coding chats it appears as an
Artifact tab next to Preview and Terminal; in plain chats it opens without creating or waking a
sandbox. The panel is resizable on desktop, full-screen capable, and modal on narrow screens.

The viewer renders Markdown with the shared safe Markdown renderer. Images, PDFs, CSV/TSV, plain
text, and JSON use the authorized inline download route, whose response applies the resource
sandboxing policy. Other formats retain download/open actions without an inline preview.

Authenticated endpoints:

- `GET /v1/chat-artifacts/:artifactId/versions` lists immutable version metadata, newest first.
- `GET /v1/chat-artifacts/:artifactId/versions/:versionId` streams authorized bytes; add
  `?download=1` for an attachment disposition.
- `DELETE /v1/chat-artifacts/:artifactId` tombstones the artifact and removes its blobs.

Phase 3 formats such as authored HTML and PDF export are intentionally separate. HTML must never be
rendered on the app origin without a hardened, egress-blocked sandbox.
