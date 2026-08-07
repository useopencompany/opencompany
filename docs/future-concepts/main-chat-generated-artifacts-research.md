# Generated Artifacts in Main Chat

Status: researched recommendation
Date: 2026-08-07

## Executive recommendation

OpenCompany should treat a requested file as a first-class, durable output of a chat turn, while
keeping ordinary sandbox files private and ephemeral.

The first version should do one thing well: when the user asks for a reusable deliverable such as a
Markdown report, spreadsheet, document, PDF, image, CSV, or JSON file, the agent explicitly publishes
that file. OpenCompany copies it out of the sandbox, stores immutable bytes and metadata, and renders
a file card in the originating assistant turn. The user can open supported previews, download the
exact version, and ask for a revision without having to understand sandbox paths.

The core product rule is:

```text
Sandbox files are working state.
Published files are user-visible artifacts.
Chat messages reference artifacts; they do not own their bytes.
```

Do not scan the sandbox after every turn, parse file paths from prose, or automatically expose every
file the agent touched. Promotion must be explicit because a runtime contains dependencies, cloned
repositories, temporary exports, credentials-adjacent configuration, and intermediate calculations
that were never meant to become user-facing deliverables.

There is no single end-user artifact standard shared by Codex, Claude, and Cursor. There is,
however, a clear agreement on the underlying shape:

1. Requested deliverables leave the ephemeral runtime and become durable objects.
2. The chat contains a reference to the output at the point it was produced.
3. A stable logical object can have multiple immutable versions.
4. Files, code changes, interactive canvases, and verification evidence are different output classes.
5. Users need a direct review surface: preview, diff, open, or download depending on the output.

The closest open protocol precedent is A2A's `Artifact`: a stable task output with an id, name,
description, and typed parts. MCP resource links and AI SDK file parts are useful transport and UI
projections, but neither is a sufficient persistence model on its own.

## User job

For a founder or a small team, the job is not "let the model write a file in Linux." It is:

> Give me a finished thing I can inspect, refine, keep, and hand to someone else without doing file
> archaeology.

Common examples:

- "Turn this research into a Markdown brief."
- "Build an Excel cash-flow model with base, upside, and downside cases."
- "Clean this CSV and give me the corrected export."
- "Convert these notes into a client-ready PDF."
- "Make the launch graphic and give me the PNG."

A trustworthy completion answers five questions without another prompt:

1. What did the agent create?
2. Can I inspect it before I rely on it?
3. Can I get the actual file?
4. Will it still exist after the runtime ends?
5. If I ask for a change, am I updating the same deliverable or creating another one?

## Output taxonomy

The market uses "artifact" for several different things. OpenCompany should keep the internal
umbrella while using familiar product language for each output.

| Output class | Example | User-facing noun | Review surface | V1 treatment |
| --- | --- | --- | --- | --- |
| File deliverable | `forecast.xlsx`, `brief.md`, `report.pdf` | File | Preview when safe, always download | Build now |
| Repository change | New or edited source files | Changes / pull request | Diff, tests, PR | Keep on existing coding path |
| Verification evidence | Screenshot, recording, trace, logs | Evidence | Inline viewer tied to the run | Later, same durable-output principles |
| Interactive object | Dashboard, calculator, live tracker | Canvas / app | Sandboxed interactive view with versions | Separate later product |
| External native document | Google Doc, Sheet, or Slide | Linked file | Open in source app | Represent as a stable external link, not copied bytes |
| Input | User-uploaded PDF or workbook | Attachment | Attachment preview/download | Keep separate from outputs |
| Working state | Temp CSV, script, dependency, cloned repo | Nothing | Not user-visible | Leave in sandbox |

This distinction matters. Calling every touched file an artifact produces noise and leaks runtime
implementation details. Treating an Excel deliverable as chat text loses formulas and formatting.
Treating a PR as a downloadable zip discards the code review workflow. Treating a living dashboard
as a static file removes the capability that makes it useful.

## What the products do

### OpenAI: files for knowledge work, diffs for coding

OpenAI now draws a clear product boundary between Work and Codex:

- ChatGPT Work creates documents, spreadsheets, presentations, reports, and Sites. Its guidance asks
  the user to name the output format and where it should be created, then review the result before
  sharing or relying on it.
- Cloud-created files may be saved to Library. Local desktop outputs remain in local projects or
  folders and do not automatically become cloud files.
- Library is independent of a single chat: it contains uploaded and generated files, supports search
  and type filters, allows reuse in another chat, and has its own deletion and download behavior.
- Canvas is a separate editing surface for substantial documents or code. It supports focused
  iteration and exports documents as PDF, Markdown, or Word, while code exports with the detected
  extension.
- Codex remains coding-specific. Its canonical output is a workspace change: file references are
  clickable, `fileChange` items feed a changes review, and cloud work can become a pull request. The
  open Codex app-server protocol has a rich `fileChange` item and aggregate turn diff, but no generic
  downloadable-artifact item.

The transferable lesson is not "build Library immediately." It is that local files, cloud files,
editable canvases, and repository diffs have different ownership and review semantics. The chat can
originate all of them without flattening them into one UI.

Sources:

- [Creating and editing files with ChatGPT Work](https://help.openai.com/en/articles/20001278-creating-and-editing-documents-spreadsheets-and-presentations-with-chatgpt-work)
- [File storage and Library in ChatGPT](https://help.openai.com/en/articles/20001052-library)
- [Canvas in ChatGPT](https://help.openai.com/en/articles/9930697-what-is-the-canvas-featue-in-chatgpt-and-how-do-i-use-it)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Introducing Codex](https://openai.com/index/introducing-codex/)

### Anthropic: real files, working locations, and separate artifacts

Anthropic exposes three related but distinct patterns:

- Regular Claude conversations can create actual XLSX, PPTX, DOCX, PDF, PNG, and analysis files in a
  private computing environment. Created files appear in the conversation for direct download or
  saving to Google Drive. The current documented limit is 30 MB per file.
- Cowork asks the user to choose a working location: a local folder or a Project. It reads from that
  scope and saves finished work back where the user can open and continue editing it. This makes the
  destination explicit before the task runs.
- Claude Artifacts are significant, self-contained content in a panel beside chat. They have a
  version selector, copy/download actions, and a separate Artifacts view. Live Cowork artifacts are
  persistent interactive HTML views that refresh against connected data and keep restorable version
  history.

Anthropic's own product language therefore separates a normal file deliverable from an interactive
artifact, even though both originate in conversation. That is a useful reason for OpenCompany to use
"File" in the initial UI rather than making users learn the backend term "artifact."

Sources:

- [Create and edit files with Claude](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude)
- [Get started in Claude Cowork](https://claude.com/resources/tutorials/get-started-in-claude-cowork-in-three-steps)
- [What are artifacts and how do I use them?](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [Use live artifacts in Claude Cowork](https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork)

### Cursor: reviewable changes and verification artifacts

Cursor is optimized for software work, so its primary output is also the code change:

- Local agent changes appear in a file-by-file diff review with accept and reject controls.
- Cloud agents produce merge-ready pull requests and attach videos, screenshots, and logs that prove
  the changed software works.
- Cursor describes those screenshots, recordings, and logs as artifacts because they let a developer
  validate agent work without reconstructing the remote session.
- Cursor canvases are a separate durable, interactive surface in the Agents Window for visualizing
  data or reviewing complex change sets.

The useful lesson is that an artifact should reduce the user's verification cost. A raw sandbox path
does not. For a spreadsheet, that means the workbook and a useful preview; for code, a diff and test
evidence; for UI work, a screenshot or recording.

Sources:

- [Cursor diffs and review](https://docs.cursor.com/en/agent/review)
- [Cursor cloud agents with computer use](https://cursor.com/blog/agent-computer-use)
- [Cursor canvases](https://cursor.com/blog/canvas)

## What the open specifications agree on

### A2A: artifact as a task output

A2A 1.0 defines an `Artifact` independently from a `Message`. It has:

- a stable `artifact_id` unique within a task;
- a human-readable name and description;
- one or more typed `Part` values;
- filenames and IANA media types on parts;
- raw bytes, a URL, text, or structured data as part content;
- streaming update events that can append to the same artifact and mark the last chunk.

This is the best semantic precedent for OpenCompany. A message says what happened; an artifact is a
tangible output of the work. OpenCompany does not need to implement A2A transport to adopt that
separation.

Source: [A2A 1.0 specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md).

### MCP: resource links from tools

MCP allows a tool result to contain a `resource_link` with a URI, programmatic name, human title,
description, MIME type, and size. It is a good shape for a `publish_artifact` tool result because the
model and host can refer to a durable file without putting its bytes in the tool transcript.

MCP does not define product ownership, immutable versions, retention, sharing, or whether a local
file should be promoted. Those remain OpenCompany responsibilities.

Source: [MCP schema reference](https://modelcontextprotocol.io/specification/2025-06-18/schema).

### AI SDK: file as an ordered UI message part

The AI SDK `UIMessage` contract includes an ordered `FileUIPart` with `mediaType`, optional
`filename`, and `url`. This is a natural browser projection for an artifact version, alongside text,
reasoning, tools, and custom data parts.

The URL-bearing UI part is not the storage record. OpenCompany should generate it from an
authorization-scoped download or preview route rather than persist a public or expiring blob URL in
message JSON.

Source: [AI SDK `UIMessage`](https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message).

## Current OpenCompany state

The current app already has most of the infrastructure around the missing seam:

- User uploads are durable private blobs described by `GoatChatMessageAttachment` and stored on user
  message rows. Auth-scoped routes serve the bytes to owners and shared-chat viewers.
- Uploaded DOCX, XLSX, CSV, TSV, Markdown, text, JSON, SRT, PDF, and image files are extracted or
  materialized for the relevant chat engine.
- Codex and Claude Code chats have persistent E2B sandboxes. Files created there remain runtime
  files; there is no output promotion contract.
- Assistant turns persist ordered text, reasoning, command, status, and subagent parts, but there is
  no file or artifact part in `CodexUiMessagePart`.
- Codex app-server `fileChange` events are normalized as coding-status rows. They represent workspace
  edits, not general deliverables.
- Deep-research tasks have one special artifact path: a final Markdown report can become a Brain
  document and emit `artifact.created`. The current task documentation still correctly notes that
  arbitrary task files are otherwise text-result only.
- `docs/future-concepts/folder-state-architecture.md` already establishes the right long-term storage
  split: Postgres owns product state, object storage owns bytes, and GitHub is a projection.

The missing capability is therefore not file generation. It is a safe, engine-neutral operation
that promotes an intended output before its sandbox disappears and projects it into the chat.

## Product contract

### Use "File" in the UI and "artifact" in the domain

Users should see a familiar file card:

```text
Quarterly forecast.xlsx
Excel workbook · 84 KB · Created just now
[Open] [Download]
```

"Artifact" can remain the internal domain term for a stable output of agent work. Reserve future
user-facing language such as "Canvas" or "App" for genuinely interactive objects.

### Do not add a destination picker to every request

Cowork needs a working-folder choice because it operates on a user's local filesystem. OpenCompany
already owns the cloud runtime and authenticated workspace, so a mandatory location prompt would add
friction without making the output safer.

The default destination should be the user's durable workspace file collection, attributed to the
originating chat. Ask for a destination only when it changes the product action: writing into a
connected Google Drive, updating an existing artifact, or committing a file into a repository. A
future Files view can add folders and organization without changing the creation contract.

### Publish only on clear deliverable intent

Publish when the user explicitly asks to create, export, convert, update, or save a file they can
use outside the chat.

Do not publish:

- temporary scripts or transformed data used to reach the answer;
- dependencies, caches, logs, or cloned repository contents;
- source-code files that belong in the normal diff/PR workflow;
- a file created only because the agent prefers writing before answering;
- every screenshot taken during browser reasoning.

If the request is ambiguous, answer in chat. The user should not get a new persistent object merely
because the harness used a filesystem internally.

### The originating turn references an exact version

The assistant message should contain an ordered reference with both `artifactId` and
`artifactVersionId`. This preserves the historical truth of what that turn produced.

Opening the card can show the exact version first and indicate when a newer version exists. A later
turn that revises the same file creates a new immutable version and emits its own reference. This
supports trustworthy chat history, shared snapshots, rollback, and concurrent edits without copying
the whole file into every message.

### One file per artifact in v1

A2A supports multipart artifacts, but the initial user job does not require bundles. One artifact
should represent one logical file with one current version. A task that creates three requested files
publishes three artifacts. Folders, zip bundles, and compound dashboards should wait until there is a
real use case.

### Preview fewer formats well

V1 should support:

- Markdown and text: render in a read-only side panel using the existing Markdown primitives.
- PNG, JPEG, and WebP: render as an image preview.
- PDF: use the browser's safe PDF viewer or a server-rendered preview.
- CSV and JSON: show a bounded text/table preview.
- XLSX, DOCX, and PPTX: show metadata and download. Add faithful previewing only when it can be done
  reliably; extracted text is not a workbook or slide-deck preview.

Every ready artifact has Download even when it has no preview. Unknown active formats, HTML, and SVG
should not be supported initially; rendering agent-created active content safely is a separate
sandboxing project.

### Private and durable by default

Published bytes must be copied out of the sandbox before the publish operation succeeds. They live
in private object storage and are served through authorization-scoped application routes. Persist a
content hash, trusted MIME type, size, and original filename. Do not store public blob URLs or
temporary signed URLs as product truth.

An artifact belongs to the user/workspace, not to the E2B sandbox and not exclusively to one chat
message. Archiving a chat must not destroy the file. A later Files/Library surface can expose the same
objects without migration.

In v1, the creating user owns the artifact. `workspace_id` is a tenancy and policy boundary, not an
implicit grant to every workspace member. Another member gets access only through an existing
authorized collaboration surface or an explicit share. Workspace-wide file visibility can be added
later with a real permissions model; it must not emerge accidentally from a database foreign key.

Keep ready artifacts until the owner deletes them or a workspace retention policy expires them. Even
before a global Files view exists, the card overflow must provide Delete. Deletion should make every
owner and share route unavailable immediately, leave a clear "File deleted" tombstone in historical
messages, and purge private bytes asynchronously after the recovery window. V1 can delete the whole
logical artifact; per-version deletion adds confusing holes to history and can wait.

### Serve generated bytes as untrusted content

Agent-created files are not trusted merely because they came from an OpenCompany sandbox. Validate
the resolved path and file type at publication, cap file count and size, compute the hash from copied
bytes, sanitize filenames, and reject symlinks, devices, sockets, and directories. Download routes
should set `X-Content-Type-Options: nosniff`, private cache policy, and a safe `Content-Disposition`.
Only formats with a deliberate safe preview path may render inline; everything else downloads as an
attachment.

Reuse the current attachment limits for the first release: at most five published files per turn and
20 MB per file. Unlike input images, generated images do not need the model-provider-specific 5 MB
input cap. Quotas can grow from observed founder workflows instead of starting with an unbounded file
service.

### Keep artifacts separate from Brain

Brain is curated, semantic, durable knowledge. An artifact is a faithful output file. A generated
workbook should not become memory merely because it exists, and automatically converting it to
Markdown would lose its actual value.

The user can explicitly save or cite an artifact in Brain later. That operation should record a
stable artifact/version reference and optionally derived searchable text. The artifact bytes remain
the source of truth for the file.

### Sharing follows the output, not its runtime

Artifacts are private by default. When an owner shares a chat, the exact generated artifact versions
referenced by the shared transcript should be available through the existing share token, just like
the visible assistant output. Sharing a chat must not expose unrelated versions, sandbox files, a
workspace-wide Files collection, or source inputs merely because they helped create the output.

This is a narrower capability than handing out the underlying private blob URL. Revoking the chat
share must revoke its artifact routes immediately.

## Suggested domain model

The durable model should distinguish logical identity, immutable bytes, and conversational
placement:

```text
artifacts
- id
- workspace_id
- owner_user_id
- kind = file
- title
- description
- current_version_id
- created_at
- updated_at
- archived_at

artifact_versions
- id
- artifact_id
- version
- filename
- mime_type
- size_bytes
- content_hash
- blob_pathname
- source_engine
- source_chat_session_id
- source_turn_id
- source_message_id
- created_at

chat_message_artifacts
- message_id
- artifact_id
- artifact_version_id
- position
```

Important invariants:

- `(artifact_id, version)` is unique and versions are immutable.
- `current_version_id` must belong to the same artifact.
- A message reference pins one version and has a stable position among other assistant parts.
- Blob pathnames are private storage pointers, not URLs returned directly to the browser.
- A publish operation is not visible as ready until bytes, hash, version row, current-version pointer,
  and message projection are consistent.
- Retrying the same publish call is idempotent.

Long term, `artifact_versions` can reference the general workspace file/version model proposed in
the folder-state architecture instead of duplicating byte storage. The artifact then becomes the
role and provenance of that file: "this file is an output of this work."

## Runtime contract

### Explicit `publish_artifact`

Give every engine capable of producing files the same semantic operation:

```text
publish_artifact(
  path,
  title?,
  description?,
  artifact_id?,
  expected_version?
) -> {
  artifact_id,
  artifact_version_id,
  filename,
  media_type,
  size_bytes,
  status: "ready"
}
```

- `path` must resolve inside an allowed sandbox work root and must be a regular file, never a symlink
  or directory.
- Omitting `artifact_id` creates a new logical artifact.
- Supplying `artifact_id` publishes a new immutable version after authorization and optional
  optimistic-version validation.
- The host derives filename, MIME type, size, and hash from the actual bytes. Agent-supplied labels
  are display hints, not security input.
- The result should be representable as an MCP resource link and projected as an artifact/file UI
  part. It should never return the private blob credential.

This should be a host operation, not a convention that asks the model to write into a magic
directory and hopes a turn-finalizer notices. Codex can receive it as an app-server dynamic tool;
Claude Code can receive it through the existing turn-scoped MCP server. The runner already knows the
active sandbox, authenticated user, workspace, session, turn, lease, and message, so it can safely
copy and attribute the bytes.

For the default OpenCompany engine, expose the same product operation through a higher-level file
creation tool or a sandbox-backed task. The persistence and UI contract should remain identical even
if the engine creates the bytes differently.

### Prompt rule

The engine instruction should stay small:

> When the user explicitly asks for a reusable file deliverable, create the final file and call
> `publish_artifact` before claiming it is ready. Do not publish scratch files, dependencies, repo
> edits, or intermediate outputs. Reference the returned file in your final response.

The tool result, not an `ls` exit code or a Markdown path, is proof that the user can access the
file.

### Revision flow

On a follow-up such as "make the downside case more conservative":

1. The turn context identifies the referenced artifact and exact version.
2. The runtime materializes that version into the sandbox when the original file is not already
   available.
3. The agent updates the file.
4. The agent calls `publish_artifact` with the existing artifact id and expected version.
5. The UI appends a new file card and exposes version history from the artifact view.

Do not silently mutate the old blob. A generated file may already have been downloaded, shared, or
used as the input to another task.

## V1 UX

1. The user asks for a file in a file-capable main-chat engine. Phase 1 covers Codex and Claude Code;
   the default engine should route to the same capability only after it has a real byte-creation path.
2. The agent works normally. Scratch files and command rows remain collapsed in the turn trace.
3. When the final deliverable is ready, the agent publishes it.
4. A compact file card appears at that position in the assistant turn, before or beside the final
   explanatory text.
5. Clicking the card opens a right-side preview on wide screens and a full-screen sheet on mobile.
6. The primary action is Open when a preview exists and Download otherwise. Download remains
   available in the overflow menu alongside Delete for the owner.
7. A follow-up edit publishes version 2 of the same file. The panel exposes a simple version selector;
   old chat turns still point to their original versions.
8. A future Files view can list these durable objects across chats, but it is not required to make
   the first file trustworthy.

Required states:

- Publishing: the card can appear with progress, but download is disabled.
- Ready: preview/download available with filename, type, and size.
- Failed: clear retry guidance; the assistant must not claim the file is available.
- Superseded: an older card remains usable and notes that a newer version exists.
- Unavailable: shared or owner route no longer has access; do not fall back to a raw blob URL.

## V1 scope

Build:

- Explicit publication from persistent Codex and Claude Code sandboxes.
- Durable artifact, version, and message-reference records.
- Authenticated and share-token-scoped byte routes.
- Markdown/text, image, PDF, CSV, and JSON previews.
- Downloads for the currently accepted file formats, adding PPTX output support even though PPTX is
  not currently an input attachment.
- New-version publication for follow-up edits.
- File cards in owner and shared transcripts.
- Owner deletion with immediate authorization revocation and delayed byte purge.
- Focused analytics and failure telemetry.

Do not build yet:

- Automatic sandbox directory scanning.
- A full workspace file manager or global Library UI.
- In-browser editing for Office formats.
- Executable HTML/SVG/React artifacts.
- Multi-file bundles and folders.
- Automatic Brain ingestion.
- Automatic publication of screenshots, logs, or test traces.
- Public artifact links independent of an owner-approved chat share.

## Rollout

### Phase 1: prove the promotion seam

- Implement the domain records and private byte routes.
- Add `publish_artifact` to Codex and Claude Code sessions.
- Render file cards and the small set of reliable previews.
- Cover sandbox teardown, retry idempotency, cross-user access, shared-chat scope, malicious
  filenames, symlinks, MIME mismatch, and oversized files.

### Phase 2: make files useful across work

- Add a Files view scoped to the user/workspace.
- Let the composer attach an existing artifact version without downloading and re-uploading it.
- Let background task and workflow handoffs pass artifact references instead of copying attachments
  or full transcripts.
- Add explicit "Save to Brain" with derived text and provenance.

### Phase 3: richer output classes

- Add verification artifacts from preview/browser work: screenshots, recordings, traces, and logs.
- Add external-native artifacts for Google Docs, Sheets, and Slides.
- Explore interactive canvases only with a dedicated sandbox, permission, versioning, and sharing
  model.

## Success criteria

The first version is successful when:

- A requested file remains openable after its E2B sandbox has been paused or destroyed.
- The user never needs to copy a sandbox path or ask "where is the file?"
- A download contains exactly the bytes and content hash of the version referenced by that turn.
- Follow-up edits create a visible new version without invalidating earlier turns or shares.
- A scratch file cannot become user-visible without an explicit publish operation.
- Neither another user nor a shared-chat token can enumerate or fetch unrelated artifacts.
- The same UI contract works for Codex and Claude Code even though their tool transports differ.

Initial product metrics:

- requested deliverables that reach `ready`;
- publish failures by engine, MIME type, and failure stage;
- open and download rate per ready artifact;
- follow-up revision rate;
- "where is the file" or missing-file follow-up rate;
- artifact reuse in a later chat once Files exists.

## Decisions this research recommends

1. Use a durable artifact entity with immutable versions, not assistant-message attachment JSON.
2. Use explicit publication, not filesystem scanning or prose parsing.
3. Call the first product surface Files; reserve interactive-artifact language for a later canvas.
4. Pin artifact versions in chat history while keeping a stable logical artifact for revisions.
5. Store metadata and current-version state in Postgres, bytes in private object storage, and serve
   them through scoped routes.
6. Keep artifacts distinct from Brain, input attachments, and repository diffs.
7. Start with persistent Codex and Claude Code sessions, but keep the contract engine-neutral.
8. Delay a global Files/Library surface until the inline creation, survival, preview, download, and
   revision loop is trustworthy.

The remaining product choice before implementation is mostly visual: whether the preview opens in
the existing coding workspace panel or a dedicated artifact panel. The persistence and runtime
contract should not depend on that choice.
