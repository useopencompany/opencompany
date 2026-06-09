# Screenshot & PDF Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can paste/drop/pick images (PNG/JPG/WebP/GIF) and PDFs into the session composer; attachments are stored in a private Vercel Blob store, shown in the thread, and sent to the model (base64-inlined by the runner), gated by per-model capability.

**Architecture:** Browser uploads directly to Vercel Blob (private store) via `upload()` + an `/api/upload` token route, so files never pass through a server action body. The user message persists attachment rows in a new `agent_session_message_attachments` table (references only — no bytes in Postgres). The runner hydrates each user message's attachments at replay time, downloads the bytes from Blob with its token, and inlines them as AI SDK v6 `image`/`file` parts. Attaching is disabled when the session's fixed model lacks vision/PDF support.

**Tech Stack:** Next.js (App Router), Drizzle + Neon Postgres, `@vercel/blob`, Vercel AI SDK v6 (`ai@^6`) via Vercel AI Gateway, Vitest, biome.

**Conventions for this plan:**
- Everything stays **local** (commit locally, no push) until the dedicated PR step. **No `Co-Authored-By` footer** in any commit.
- Commands run from repo root unless stated. Tests: `bun run test`; lint: `bun run lint`; format (CI-equivalent): `bunx biome check .` (or `--write`).
- The spec this implements: `docs/superpowers/specs/2026-06-05-screenshot-paste-design.md`.

---

## File Structure

**Create:**
- `packages/agent-runtime/src/attachments.ts` — shared attachment constants, kinds, MIME validation, `modelSupportsAttachments`. Single source of truth for web + server + runner.
- `packages/agent-runtime/src/attachments.test.ts` — unit tests for the above.
- `apps/web/app/api/upload/route.ts` — Blob client-upload token route (`handleUpload`).
- `apps/web/app/api/attachments/[id]/route.ts` — auth-scoped byte-serving route for the thread UI.
- `apps/web/components/composer-attachments.tsx` — attachment chip/preview row + the `PendingAttachment` type and upload helper used by the composer.

**Modify:**
- `packages/db/src/schema.ts` — new `agentSessionMessageAttachments` table.
- `packages/agent-runtime/src/models.ts` — add `supportsImages`/`supportsPdf` to `AgentModelDefinition` + catalog.
- `packages/agent-runtime/src/index.ts` (or wherever the package re-exports) — export the new attachments module.
- `apps/web/lib/agent-sessions/actions.ts` — thread attachments through `submitAgentSessionMessage` + `insertUserMessage`.
- `apps/web/lib/agent-sessions/runtime-events.ts` — add `attachments?` to `SessionMessage`.
- `apps/web/components/SessionView.tsx` — attachments state, wire paste/drop/picker, gate, send-gating, render attachments in user bubbles.
- `apps/runner/src/model-messages.ts` — extend `StoredSessionMessageForModelReplay` + build image/file parts for user messages.
- The runner message-loading path (the function that selects `agent_session_messages` and maps to `StoredSessionMessageForModelReplay[]`, reached from `apps/runner/src/agent-loop.ts`) — load attachment rows + hydrate base64.
- `apps/web/package.json`, `apps/runner/package.json` — add `@vercel/blob`.
- `.env.example` — document `BLOB_READ_WRITE_TOKEN`.

---

## Task 1: Shared attachment constants + validation

**Files:**
- Create: `packages/agent-runtime/src/attachments.ts`
- Test: `packages/agent-runtime/src/attachments.test.ts`
- Modify: package barrel export (e.g. `packages/agent-runtime/src/index.ts`)

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-runtime/src/attachments.test.ts
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  attachmentKindForMime,
  isAllowedAttachmentMime,
  validateAttachmentCandidate,
} from "./attachments";

describe("attachment validation", () => {
  it("classifies image and pdf mime types", () => {
    expect(attachmentKindForMime("image/png")).toBe("image");
    expect(attachmentKindForMime("application/pdf")).toBe("pdf");
    expect(attachmentKindForMime("text/plain")).toBeNull();
  });

  it("allows the supported mime set only", () => {
    expect(isAllowedAttachmentMime("image/jpeg")).toBe(true);
    expect(isAllowedAttachmentMime("image/svg+xml")).toBe(false);
  });

  it("rejects oversized files", () => {
    const result = validateAttachmentCandidate({
      mediaType: "image/png",
      sizeBytes: ATTACHMENT_MAX_BYTES + 1,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a valid candidate", () => {
    const result = validateAttachmentCandidate({ mediaType: "application/pdf", sizeBytes: 1000 });
    expect(result).toEqual({ ok: true, kind: "pdf" });
  });

  it("exposes a per-message cap", () => {
    expect(ATTACHMENT_MAX_PER_MESSAGE).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test --filter @opencompany/agent-runtime -- attachments`
Expected: FAIL — `Cannot find module './attachments'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/agent-runtime/src/attachments.ts
export type AttachmentKind = "image" | "pdf";

export const ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const ATTACHMENT_PDF_MIME_TYPES = ["application/pdf"] as const;

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  ...ATTACHMENT_IMAGE_MIME_TYPES,
  ...ATTACHMENT_PDF_MIME_TYPES,
] as const;

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const ATTACHMENT_MAX_PER_MESSAGE = 10;

export function attachmentKindForMime(mediaType: string): AttachmentKind | null {
  if ((ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mediaType)) return "image";
  if ((ATTACHMENT_PDF_MIME_TYPES as readonly string[]).includes(mediaType)) return "pdf";
  return null;
}

export function isAllowedAttachmentMime(mediaType: string): boolean {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mediaType);
}

export type AttachmentValidation =
  | { ok: true; kind: AttachmentKind }
  | { ok: false; reason: "type" | "size" };

export function validateAttachmentCandidate(input: {
  mediaType: string;
  sizeBytes: number;
}): AttachmentValidation {
  const kind = attachmentKindForMime(input.mediaType);
  if (!kind) return { ok: false, reason: "type" };
  if (input.sizeBytes > ATTACHMENT_MAX_BYTES || input.sizeBytes <= 0) {
    return { ok: false, reason: "size" };
  }
  return { ok: true, kind };
}
```

- [ ] **Step 4: Add the barrel export**

In the agent-runtime package entrypoint (`packages/agent-runtime/src/index.ts`), add:

```ts
export * from "./attachments";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test --filter @opencompany/agent-runtime -- attachments`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit (local)**

```bash
git add packages/agent-runtime/src/attachments.ts packages/agent-runtime/src/attachments.test.ts packages/agent-runtime/src/index.ts
git commit -m "feat(attachments): shared attachment constants + validation"
```

---

## Task 2: Per-model vision/PDF capability metadata

**Files:**
- Modify: `packages/agent-runtime/src/models.ts`
- Modify/extend: `packages/agent-runtime/src/attachments.ts` (add `modelSupportsAttachments`)
- Test: `packages/agent-runtime/src/attachments.test.ts`

- [ ] **Step 1: Write the failing test (append to attachments.test.ts)**

```ts
import { modelSupportsAttachments } from "./attachments";
import { AGENT_MODEL_CATALOG } from "./models";

describe("modelSupportsAttachments", () => {
  it("reports image support for a vision model id", () => {
    const visionModel = AGENT_MODEL_CATALOG.find((m) => m.supportsImages);
    expect(visionModel).toBeDefined();
    expect(modelSupportsAttachments(visionModel!.id).images).toBe(true);
  });

  it("returns all-false for an unknown model id", () => {
    expect(modelSupportsAttachments("nonexistent/model")).toEqual({ images: false, pdf: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test --filter @opencompany/agent-runtime -- attachments`
Expected: FAIL — `modelSupportsAttachments is not a function` / no model has `supportsImages`.

- [ ] **Step 3: Extend the model definition type**

In `packages/agent-runtime/src/models.ts`, add to `AgentModelDefinition` (after `supportsReasoning: boolean;`, line ~22):

```ts
  supportsImages?: boolean;
  supportsPdf?: boolean;
```

- [ ] **Step 4: Mark vision/PDF-capable catalog entries**

For each entry in `AGENT_MODEL_CATALOG` whose underlying model accepts images, add `supportsImages: true`; add `supportsPdf: true` where it accepts PDFs (Claude / Gemini / GPT vision families). Example for the GPT entry already at the top of the catalog:

```ts
  {
    id: "openai/gpt-5.4-mini",
    type: "model",
    label: "GPT 5.4 Mini",
    description: "Fast GPT model with light thinking for everyday agent work.",
    category: "Fast",
    supportsReasoning: true,
    supportsImages: true,
    supportsPdf: true,
    ratings: { capability: 2, speed: 3, cost: 2 },
    reasoning: { /* unchanged */ },
  },
```

Audit every catalog entry and set the two flags explicitly per model family (omit/`false` for text-only models such as lightweight non-vision variants). Keep them next to `supportsReasoning` for consistency.

- [ ] **Step 5: Add `modelSupportsAttachments` to attachments.ts**

```ts
// packages/agent-runtime/src/attachments.ts (append)
import { AGENT_MODEL_CATALOG } from "./models";

export function modelSupportsAttachments(modelId: string): { images: boolean; pdf: boolean } {
  const model = AGENT_MODEL_CATALOG.find((entry) => entry.id === modelId);
  return { images: Boolean(model?.supportsImages), pdf: Boolean(model?.supportsPdf) };
}
```

> If this creates an import cycle (`models.ts` importing `attachments.ts` or vice-versa), keep `modelSupportsAttachments` in `models.ts` instead and re-export it from `attachments.ts`. Verify with `bun run typecheck`.

- [ ] **Step 6: Run tests + typecheck**

Run: `bun run test --filter @opencompany/agent-runtime -- attachments`
Expected: PASS.
Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit (local)**

```bash
git add packages/agent-runtime/src/models.ts packages/agent-runtime/src/attachments.ts packages/agent-runtime/src/attachments.test.ts
git commit -m "feat(attachments): per-model image/pdf capability flags"
```

---

## Task 3: Attachments DB table + migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create (generated): a Drizzle migration under the db package's migrations dir.

- [ ] **Step 1: Add the table after `agentSessionMessages`**

In `packages/db/src/schema.ts`, immediately after the `agentSessionMessages` table (ends line ~552), add:

```ts
// User-uploaded attachments for a session message (images + PDFs). References to Vercel
// Blob objects only — bytes live in the private Blob store, never in Postgres. Cascade-
// deleted with the message; the blob objects are deleted explicitly in app code.
export const agentSessionMessageAttachments = pgTable(
  "agent_session_message_attachments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => agentSessionMessages.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"image" | "pdf">().notNull(),
    mediaType: text("media_type").notNull(),
    filename: text("filename").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    blobPathname: text("blob_pathname").notNull(),
    blobUrl: text("blob_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageIdx: index("agent_session_message_attachments_message_idx").on(table.messageId),
    sessionIdx: index("agent_session_message_attachments_session_idx").on(table.sessionId),
    kindCheck: check(
      "agent_session_message_attachments_kind_check",
      sql`${table.kind} IN ('image', 'pdf')`,
    ),
  }),
);
```

(`text`, `integer`, `index`, `check`, `sql`, `pgTable`, `timestamp` are already imported at the top of the file.)

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new migration file is created adding `agent_session_message_attachments`. Inspect it — it must ONLY add the new table (no unrelated schema drift).

- [ ] **Step 3: Verify types compile**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Apply locally + sanity check**

Run: `bun run db:migrate`
Expected: applies cleanly against the local Neon branch. (QA note: anyone running the app on this branch must `bun run db:migrate`.)

- [ ] **Step 5: Commit (local)**

```bash
git add packages/db/src/schema.ts packages/db/**/migrations/**
git commit -m "feat(attachments): add agent_session_message_attachments table"
```

---

## Task 4: `@vercel/blob` dependency + env documentation

**Files:**
- Modify: `apps/web/package.json`, `apps/runner/package.json`, `.env.example`

- [ ] **Step 1: Add the dependency to both apps**

```bash
cd apps/web && bun add @vercel/blob && cd ../..
cd apps/runner && bun add @vercel/blob && cd ../..
```

- [ ] **Step 2: Document the env var**

In `.env.example`, add a section (near the other service tokens, e.g. after the E2B / AI Gateway block ~line 143):

```bash
# Vercel Blob — private store for user-uploaded message attachments (images/PDFs).
# Web mints client-upload tokens; the runner downloads bytes to inline into model calls.
BLOB_READ_WRITE_TOKEN=""
```

- [ ] **Step 3: Verify install + typecheck**

Run: `bun install --frozen-lockfile` (sanity) then `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit (local)**

```bash
git add apps/web/package.json apps/runner/package.json bun.lock .env.example
git commit -m "chore(attachments): add @vercel/blob + document BLOB_READ_WRITE_TOKEN"
```

> **Setup-Schritt (out-of-band, before the PR is mergeable):** create a **private** Blob store and set `BLOB_READ_WRITE_TOKEN` in Infisical `dev` + `prod` and the Vercel project env. Not a code step.

---

## Task 5: Upload token route (`/api/upload`)

**Files:**
- Create: `apps/web/app/api/upload/route.ts`

- [ ] **Step 1: Implement the route**

```ts
// apps/web/app/api/upload/route.ts
import { ALLOWED_ATTACHMENT_MIME_TYPES, ATTACHMENT_MAX_BYTES } from "@opencompany/agent-runtime";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { currentWorkspace } from "@/lib/auth";

// Mints short-lived client-upload tokens so the browser uploads directly to the private
// Blob store (bypasses the 4.5 MB serverless body limit). Auth + content-type + size are
// enforced here; the DB rows are written at message-submit time (onUploadCompleted does
// NOT fire on localhost, so we do not rely on it).
export async function POST(request: Request): Promise<Response> {
  const context = await currentWorkspace({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(`workspace/${context.workspace.id}/`)) {
          throw new Error("Pathname outside workspace scope.");
        }
        return {
          access: "private",
          addRandomSuffix: true,
          allowedContentTypes: [...ALLOWED_ATTACHMENT_MIME_TYPES],
          maximumSizeInBytes: ATTACHMENT_MAX_BYTES,
        };
      },
      onUploadCompleted: async () => {
        // Intentionally empty — persistence happens at message submit. Does not run locally.
      },
    });
    return Response.json(jsonResponse);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 400 },
    );
  }
}
```

> **Verify against current `@vercel/blob` docs (context7 `@vercel/blob`) at implementation time:** the exact option name for the private tier (`access: "private"`) and `onBeforeGenerateToken`'s return shape. The private-store API is recent — confirm field names before relying on them.

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bunx biome check apps/web/app/api/upload/route.ts`
Expected: PASS.

- [ ] **Step 3: Commit (local)**

```bash
git add apps/web/app/api/upload/route.ts
git commit -m "feat(attachments): client-upload token route for Vercel Blob"
```

---

## Task 6: Composer attachment UI

**Files:**
- Create: `apps/web/components/composer-attachments.tsx`
- Modify: `apps/web/components/SessionView.tsx`

- [ ] **Step 1: Create the attachment type + chip row + upload helper**

```tsx
// apps/web/components/composer-attachments.tsx
"use client";

import {
  type AttachmentKind,
  validateAttachmentCandidate,
} from "@opencompany/agent-runtime";
import { upload } from "@vercel/blob/client";
import { FileText, X } from "lucide-react";

export type PendingAttachment = {
  id: string;
  filename: string;
  mediaType: string;
  kind: AttachmentKind;
  sizeBytes: number;
  status: "uploading" | "ready" | "error";
  previewUrl?: string; // object URL for image preview
  blobPathname?: string;
  blobUrl?: string;
  error?: string;
};

// Uploads a File to the private Blob store under the session's scope, returning the
// updated attachment. Caller is responsible for adding/removing the local id.
export async function uploadAttachment(input: {
  id: string;
  file: File;
  kind: AttachmentKind;
  workspaceId: string;
  sessionId: string;
}): Promise<{ blobPathname: string; blobUrl: string }> {
  const safeName = input.file.name.replace(/[^\w.\-]+/g, "_") || "file";
  const pathname = `workspace/${input.workspaceId}/sessions/${input.sessionId}/${input.id}-${safeName}`;
  const blob = await upload(pathname, input.file, {
    access: "private",
    handleUploadUrl: "/api/upload",
    contentType: input.file.type,
  });
  return { blobPathname: blob.pathname, blobUrl: blob.url };
}

export function ComposerAttachments({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="group relative flex items-center gap-2 rounded-md border border-ink-subtle/40 bg-surface px-2 py-1.5 text-[12px] text-ink"
        >
          {att.kind === "image" && att.previewUrl ? (
            <img
              src={att.previewUrl}
              alt={att.filename}
              className="h-8 w-8 rounded object-cover"
            />
          ) : (
            <FileText size={16} strokeWidth={1.75} className="text-ink-muted" />
          )}
          <span className="max-w-[140px] truncate">{att.filename}</span>
          {att.status === "uploading" ? <span className="text-ink-subtle">…</span> : null}
          {att.status === "error" ? (
            <span className="text-danger" title={att.error}>
              !
            </span>
          ) : null}
          <button
            type="button"
            aria-label={`Remove ${att.filename}`}
            onClick={() => onRemove(att.id)}
            className="ml-1 text-ink-muted hover:text-ink"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}
```

> Match icon library + design tokens to the existing `SessionView.tsx` imports (`lucide-react`, `text-ink`, `bg-surface`, etc.). Adjust class names to the codebase's tokens if these differ.

- [ ] **Step 2: Add state + a shared file-intake handler in SessionView**

In `apps/web/components/SessionView.tsx`, near the existing state (around line 265, beside `const [input, setInput] = useState("")`), add:

```tsx
const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
const attachmentCapability = modelSupportsAttachments(session.modelName);
const attachmentsEnabled = attachmentCapability.images || attachmentCapability.pdf;

const acceptFiles = useCallback(
  (files: File[]) => {
    if (!attachmentsEnabled) return;
    setAttachments((prev) => {
      const next = [...prev];
      for (const file of files) {
        if (next.length >= ATTACHMENT_MAX_PER_MESSAGE) {
          showToast({ title: "Limit reached", description: `Max ${ATTACHMENT_MAX_PER_MESSAGE} files.`, tone: "default" });
          break;
        }
        const validation = validateAttachmentCandidate({ mediaType: file.type, sizeBytes: file.size });
        if (!validation.ok) {
          showToast({
            title: validation.reason === "size" ? "File too large" : "Unsupported file",
            description: validation.reason === "size" ? "Max 25 MB per file." : "Only images and PDFs.",
            tone: "default",
          });
          continue;
        }
        if (validation.kind === "pdf" && !attachmentCapability.pdf) continue;
        if (validation.kind === "image" && !attachmentCapability.images) continue;
        const id = crypto.randomUUID();
        next.push({
          id,
          filename: file.name,
          mediaType: file.type,
          kind: validation.kind,
          sizeBytes: file.size,
          status: "uploading",
          previewUrl: validation.kind === "image" ? URL.createObjectURL(file) : undefined,
        });
        void uploadAttachment({ id, file, kind: validation.kind, workspaceId: session.workspaceId, sessionId: session.id })
          .then((res) =>
            setAttachments((cur) =>
              cur.map((a) => (a.id === id ? { ...a, status: "ready", ...res } : a)),
            ),
          )
          .catch((err) =>
            setAttachments((cur) =>
              cur.map((a) => (a.id === id ? { ...a, status: "error", error: String(err) } : a)),
            ),
          );
      }
      return next;
    });
  },
  [attachmentsEnabled, attachmentCapability, session.id, session.workspaceId],
);

const removeAttachment = useCallback((id: string) => {
  setAttachments((prev) => {
    const target = prev.find((a) => a.id === id);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    if (target?.blobPathname) void fetch(`/api/attachments/${id}`, { method: "DELETE" }).catch(() => {});
    return prev.filter((a) => a.id !== id);
  });
}, []);
```

Add the imports at the top of `SessionView.tsx`:

```tsx
import { ATTACHMENT_MAX_PER_MESSAGE, modelSupportsAttachments, validateAttachmentCandidate } from "@opencompany/agent-runtime";
import { ComposerAttachments, type PendingAttachment, uploadAttachment } from "@/components/composer-attachments";
```

(Confirm `session.workspaceId` is available on the detail object the component already reads; if not, read it from the existing context the component uses for the workspace id.)

- [ ] **Step 3: Wire the three intake paths (replace the toasts)**

- **Paste** (`SessionView.tsx:1077-1098`): replace the toast body with file extraction:

```tsx
onPaste={(event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  const files = Array.from(items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
  if (files.length === 0) return;
  event.preventDefault();
  acceptFiles(files);
}}
```

- **Drop** (`SessionView.tsx:876-882`): replace the toast in `onDrop` with:

```tsx
if (event.dataTransfer.files.length > 0) {
  acceptFiles(Array.from(event.dataTransfer.files));
}
```

- **Attach menu "Upload file"** (`SessionView.tsx:1006-1016`): replace the toast `onClick` with a hidden `<input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf">` whose `onChange` calls `acceptFiles(Array.from(e.target.files ?? []))`, then `setAttachMenuOpen(false)`.

- [ ] **Step 4: Gate the affordances by capability**

- The attach "+" button (`SessionView.tsx:991-998`): add `disabled={!attachmentsEnabled}` and a `title`/tooltip "Das Modell dieser Session unterstützt keine Uploads." when disabled.
- In the drag overlay (`SessionView.tsx:885-896`), only treat a drag as active when `attachmentsEnabled` (otherwise ignore the drop — `acceptFiles` already no-ops, but skip the overlay too).

- [ ] **Step 5: Render the chip row + gate Send**

- Render `<ComposerAttachments attachments={attachments} onRemove={removeAttachment} />` just above the textarea row.
- Send button: disable while any attachment is not `ready` — extend the existing send-disabled condition with `|| attachments.some((a) => a.status !== "ready")`.

- [ ] **Step 6: Verify build/lint/typecheck**

Run: `bun run typecheck && bunx biome check apps/web/components/SessionView.tsx apps/web/components/composer-attachments.tsx`
Expected: PASS.

- [ ] **Step 7: Commit (local)**

```bash
git add apps/web/components/composer-attachments.tsx apps/web/components/SessionView.tsx
git commit -m "feat(attachments): wire composer paste/drop/picker + capability gate"
```

---

## Task 7: Persist attachments through submit

**Files:**
- Modify: `apps/web/lib/agent-sessions/actions.ts`
- Modify: `apps/web/components/SessionView.tsx` (pass attachments on submit, then clear)

- [ ] **Step 1: Define the submit input + extend the server action**

In `apps/web/lib/agent-sessions/actions.ts`, add the import:

```ts
import { agentSessionMessageAttachments } from "@opencompany/db/schema";
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  modelSupportsAttachments,
  validateAttachmentCandidate,
} from "@opencompany/agent-runtime";
import { newAgentSessionMessageAttachmentId } from "@opencompany/agent-runtime"; // add this id helper alongside newAgentSessionMessageId
```

> Add `newAgentSessionMessageAttachmentId()` next to the existing `newAgentSessionMessageId()` id factory in agent-runtime (same prefix/format convention). One-liner; include it in this task's commit.

Change the signature (line 159) to accept attachments and validate them server-side:

```ts
export type SubmitAttachmentInput = {
  blobPathname: string;
  blobUrl: string;
  mediaType: string;
  filename: string;
  sizeBytes: number;
};

export async function submitAgentSessionMessage(
  sessionId: string,
  content: string,
  attachments: SubmitAttachmentInput[] = [],
) {
  const { user, workspace } = await currentWorkspace();
  const trimmed = content.trim();
  if (!trimmed && attachments.length === 0) {
    return { ok: false, error: "Message is required." } as const;
  }
  // ... existing balance + session lookup (unchanged) ...
```

After the `session` is resolved (line ~197), add validation:

```ts
  if (attachments.length > ATTACHMENT_MAX_PER_MESSAGE) {
    return { ok: false, error: "Too many attachments." } as const;
  }
  const capability = modelSupportsAttachments(session.modelName);
  for (const att of attachments) {
    const result = validateAttachmentCandidate({ mediaType: att.mediaType, sizeBytes: att.sizeBytes });
    if (!result.ok) return { ok: false, error: "Unsupported or oversized attachment." } as const;
    if (result.kind === "image" && !capability.images) return { ok: false, error: "Model can't read images." } as const;
    if (result.kind === "pdf" && !capability.pdf) return { ok: false, error: "Model can't read PDFs." } as const;
    if (!att.blobPathname.startsWith(`workspace/${workspace.id}/`)) {
      return { ok: false, error: "Attachment outside workspace scope." } as const;
    }
  }
```

Pass attachments into `insertUserMessage`:

```ts
  const { message } = await insertUserMessage(sessionId, trimmed, {
    workspaceId: workspace.id,
    attachments,
  });
```

- [ ] **Step 2: Extend `insertUserMessage` to write attachment rows**

Replace the `insertUserMessage` body (lines 733-784) so the batch also inserts attachment rows (keep the `modelMessage` text-only — bytes are NOT stored here):

```ts
async function insertUserMessage(
  sessionId: string,
  content: string,
  options: { workspaceId: string; attachments: SubmitAttachmentInput[] },
) {
  const db = getDb();
  const messageId = newAgentSessionMessageId();
  const payload = { messageId, role: "user", content, status: "completed" };

  const attachmentRows = options.attachments.map((att) => {
    const kind = validateAttachmentCandidate({ mediaType: att.mediaType, sizeBytes: att.sizeBytes });
    return {
      id: newAgentSessionMessageAttachmentId(),
      messageId,
      sessionId,
      workspaceId: options.workspaceId,
      kind: kind.ok ? kind.kind : "image",
      mediaType: att.mediaType,
      filename: att.filename,
      sizeBytes: att.sizeBytes,
      blobPathname: att.blobPathname,
      blobUrl: att.blobUrl,
    };
  });

  const batchOps = [
    db
      .insert(agentSessionMessages)
      .values({
        id: messageId,
        sessionId,
        role: "user",
        status: "completed",
        content,
        modelMessage: { role: "user", content },
        completedAt: new Date(),
      })
      .returning(),
    db
      .insert(agentSessionEvents)
      .values({ sessionId, messageId, type: "message.created", payload })
      .returning({ id: agentSessionEvents.id, createdAt: agentSessionEvents.createdAt }),
  ];
  if (attachmentRows.length > 0) {
    batchOps.push(db.insert(agentSessionMessageAttachments).values(attachmentRows).returning());
  }

  const [messageRows, eventRows] = await db.batch(batchOps as Parameters<typeof db.batch>[0]);
  // ... rest unchanged (message/eventRow extraction, durable-stream append, return) ...
}
```

> `db.batch` is variadic-tuple typed; if pushing conditionally fights the types, branch into two `db.batch([...])` literals (with vs without the attachments insert) instead of mutating the array. Keep the message + event inserts atomic.

- [ ] **Step 3: Submit attachments from the client + clear on success**

In `SessionView.tsx` `submit()` (around line 803), build the attachment payload from `ready` attachments and pass it; on success clear `attachments` (and revoke object URLs):

```tsx
const ready = attachments.filter((a) => a.status === "ready" && a.blobPathname && a.blobUrl);
const result = await submitAgentSessionMessage(
  session.id,
  content,
  ready.map((a) => ({
    blobPathname: a.blobPathname!,
    blobUrl: a.blobUrl!,
    mediaType: a.mediaType,
    filename: a.filename,
    sizeBytes: a.sizeBytes,
  })),
);
// on ok:
attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
setAttachments([]);
```

- [ ] **Step 4: Typecheck + lint**

Run: `bun run typecheck && bunx biome check apps/web/lib/agent-sessions/actions.ts`
Expected: PASS.

- [ ] **Step 5: Commit (local)**

```bash
git add apps/web/lib/agent-sessions/actions.ts apps/web/components/SessionView.tsx packages/agent-runtime/src
git commit -m "feat(attachments): persist message attachments on submit"
```

---

## Task 8: Runner — inline image/PDF parts into model messages

**Files:**
- Modify: `apps/runner/src/model-messages.ts`
- Test: `apps/runner/src/model-messages.test.ts` (create if absent)
- Modify: the runner message-loading path (selects `agent_session_messages`, reached from `apps/runner/src/agent-loop.ts`)

- [ ] **Step 1: Extend the stored-message type**

In `apps/runner/src/model-messages.ts`, extend `StoredSessionMessageForModelReplay` (lines 15-20):

```ts
export type ReplayAttachment = {
  kind: "image" | "pdf";
  mediaType: string;
  filename: string;
  base64: string; // hydrated by the loader (bytes downloaded from Blob)
};

export type StoredSessionMessageForModelReplay = {
  id?: string;
  role: string;
  content: string;
  modelMessage?: PersistedModelMessage | null;
  attachments?: ReplayAttachment[];
};
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/runner/src/model-messages.test.ts
import { describe, expect, it } from "vitest";
import { buildModelMessages } from "./model-messages";

describe("buildModelMessages with attachments", () => {
  it("builds an image part for a user message with an image attachment", () => {
    const [message] = buildModelMessages([
      {
        id: "m1",
        role: "user",
        content: "look at this",
        modelMessage: { role: "user", content: "look at this" },
        attachments: [{ kind: "image", mediaType: "image/png", filename: "a.png", base64: "AAAA" }],
      },
    ]);
    expect(message.role).toBe("user");
    expect(Array.isArray(message.content)).toBe(true);
    const parts = message.content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: "text", text: "look at this" });
    expect(parts[1]).toMatchObject({ type: "image", mediaType: "image/png" });
  });

  it("builds a file part for a PDF attachment", () => {
    const [message] = buildModelMessages([
      {
        id: "m2",
        role: "user",
        content: "",
        modelMessage: { role: "user", content: "" },
        attachments: [{ kind: "pdf", mediaType: "application/pdf", filename: "d.pdf", base64: "JVBER" }],
      },
    ]);
    const parts = message.content as Array<Record<string, unknown>>;
    expect(parts.some((p) => p.type === "file" && p.mediaType === "application/pdf")).toBe(true);
  });

  it("leaves attachment-free user messages as plain text", () => {
    const [message] = buildModelMessages([
      { id: "m3", role: "user", content: "hi", modelMessage: { role: "user", content: "hi" } },
    ]);
    expect(message.content).toBe("hi");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun run test --filter @opencompany/runner -- model-messages`
Expected: FAIL — attachments produce no parts yet.

- [ ] **Step 4: Build attachment parts in `buildModelMessages`**

In `buildModelMessages` (after `const modelMessage = readStoredModelMessage(message);`, line 36), insert a user-attachment short-circuit:

```ts
    if (message.role === "user" && message.attachments && message.attachments.length > 0) {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content) parts.push({ type: "text", text: message.content });
      for (const att of message.attachments) {
        if (att.kind === "image") {
          parts.push({ type: "image", image: att.base64, mediaType: att.mediaType });
        } else {
          parts.push({
            type: "file",
            data: att.base64,
            mediaType: att.mediaType,
            filename: att.filename,
          });
        }
      }
      messages.push(validateModelMessage({ role: "user", content: parts }, message.id));
      continue;
    }
```

> Confirm against AI SDK v6 (context7 `ai`): image part field is `image`, file part field is `data`, media field is `mediaType`. `modelMessageSchema.safeParse` (used by `validateModelMessage`) must accept these — if base64 needs a `data:` URL prefix for the schema, prefix it (`data:${mediaType};base64,${base64}`). Adjust the test expectation accordingly.

- [ ] **Step 5: Run to verify it passes**

Run: `bun run test --filter @opencompany/runner -- model-messages`
Expected: PASS (3 tests).

- [ ] **Step 6: Hydrate attachments in the message-loading path**

Locate the runner function that loads `agent_session_messages` rows and maps them to `StoredSessionMessageForModelReplay[]` (reached from `agent-loop.ts` ~line 358 via `loadSession`). For each user message, fetch its rows from `agentSessionMessageAttachments` (by `messageId`), download each blob's bytes from the **private** store using the runner's `BLOB_READ_WRITE_TOKEN`, base64-encode, and attach as `ReplayAttachment[]`. Sketch:

```ts
import { agentSessionMessageAttachments } from "@opencompany/db/schema";
// inside the loader, after fetching message rows:
const rows = await db
  .select()
  .from(agentSessionMessageAttachments)
  .where(inArray(agentSessionMessageAttachments.messageId, userMessageIds));
const byMessage = new Map<string, ReplayAttachment[]>();
for (const row of rows) {
  const bytes = await downloadBlobBytes(row.blobPathname); // see note
  byMessage.set(row.messageId, [
    ...(byMessage.get(row.messageId) ?? []),
    { kind: row.kind, mediaType: row.mediaType, filename: row.filename, base64: Buffer.from(bytes).toString("base64") },
  ]);
}
// then set `attachments: byMessage.get(message.id)` on the mapped stored message.
```

> **`downloadBlobBytes` — verify the exact `@vercel/blob` private-download API via context7 at implementation time.** Per research (June 2026), the path is: mint a short-lived signed GET token (`issueSignedToken({ pathname, operations: ['get'], validUntil })`) + `presignUrl(...)`, then `fetch` the presigned URL and read `arrayBuffer()`. This is the runner fetching its OWN bytes (never a URL handed to the model). Cache within a single run to avoid re-downloading on multi-turn replay.

- [ ] **Step 7: Typecheck + full runner tests**

Run: `bun run typecheck && bun run test --filter @opencompany/runner`
Expected: PASS.

- [ ] **Step 8: Commit (local)**

```bash
git add apps/runner/src/model-messages.ts apps/runner/src/model-messages.test.ts apps/runner/src
git commit -m "feat(attachments): runner inlines image/pdf parts into model messages"
```

---

## Task 9: Serve attachments to the thread + render

**Files:**
- Create: `apps/web/app/api/attachments/[id]/route.ts`
- Modify: `apps/web/lib/agent-sessions/runtime-events.ts`
- Modify: the detail query that builds `detail.messages` (the data loader that returns `SessionMessage[]`)
- Modify: `apps/web/components/SessionView.tsx` (`renderMessage`)

- [ ] **Step 1: Add `attachments` to the `SessionMessage` type**

In `apps/web/lib/agent-sessions/runtime-events.ts`, extend `SessionMessage` (after line 14):

```ts
  attachments?: Array<{
    id: string;
    kind: "image" | "pdf";
    mediaType: string;
    filename: string;
  }>;
```

- [ ] **Step 2: Serve-route (GET = bytes, DELETE = remove)**

```ts
// apps/web/app/api/attachments/[id]/route.ts
import { getDb } from "@opencompany/db/client";
import { agentSessionMessageAttachments } from "@opencompany/db/schema";
import { del } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await currentWorkspace({ optional: true, skipOnboarding: true });
  if (!context) return new Response(null, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [row] = await db
    .select()
    .from(agentSessionMessageAttachments)
    .where(eq(agentSessionMessageAttachments.id, id))
    .limit(1);
  if (!row || row.workspaceId !== context.workspace.id) return new Response(null, { status: 404 });

  // Download from the private store with the server token, stream back. (See Task 8 note
  // on the private-download API — reuse the same helper.)
  const bytes = await downloadBlobBytes(row.blobPathname);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": row.mediaType,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await currentWorkspace({ optional: true, skipOnboarding: true });
  if (!context) return new Response(null, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [row] = await db
    .select()
    .from(agentSessionMessageAttachments)
    .where(eq(agentSessionMessageAttachments.id, id))
    .limit(1);
  if (!row || row.workspaceId !== context.workspace.id) return new Response(null, { status: 404 });
  await del(row.blobUrl);
  await db.delete(agentSessionMessageAttachments).where(eq(agentSessionMessageAttachments.id, id));
  return new Response(null, { status: 204 });
}
```

> The `DELETE` path here removes a *persisted* attachment. The composer's pre-send remove (Task 6 `removeAttachment`) deletes a not-yet-persisted blob — that has no DB row yet, so guard the composer call to only `del` the blob (no DB row exists pre-submit). Reconcile: pre-submit removal should call `del(blobUrl)` directly via a tiny `/api/upload` DELETE or a dedicated route — simplest is to skip server-side cleanup pre-submit and let an orphan-sweep handle it, OR delete by pathname. Decide at implementation: for v1, pre-submit removal just drops the local chip and best-effort `del`s by pathname; persisted removal uses this route. Keep it consistent and documented.

- [ ] **Step 3: Include attachments in the detail messages query**

In the loader that builds `detail.messages` (returns `SessionMessage[]`), left-join / batch-select `agentSessionMessageAttachments` by the message ids and attach `attachments: [{ id, kind, mediaType, filename }]` (NO bytes, NO blob URL — the UI uses `/api/attachments/[id]`). Mirror the existing select/shape pattern in that file.

- [ ] **Step 4: Render attachments in user bubbles**

In `SessionView.tsx` `renderMessage` (line 504, the `: ( message.content )` user branch), replace with:

```tsx
) : (
  <div className="flex flex-col gap-2">
    {message.content ? <div>{message.content}</div> : null}
    {message.attachments && message.attachments.length > 0 ? (
      <div className="flex flex-wrap gap-2">
        {message.attachments.map((att) =>
          att.kind === "image" ? (
            <a key={att.id} href={`/api/attachments/${att.id}`} target="_blank" rel="noreferrer">
              <img
                src={`/api/attachments/${att.id}`}
                alt={att.filename}
                className="max-h-48 max-w-xs rounded-md border border-ink-subtle/30 object-cover"
              />
            </a>
          ) : (
            <a
              key={att.id}
              href={`/api/attachments/${att.id}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-md border border-ink-subtle/40 bg-surface px-2 py-1.5 text-[12px] text-ink"
            >
              <FileText size={16} strokeWidth={1.75} className="text-ink-muted" />
              <span className="max-w-[160px] truncate">{att.filename}</span>
            </a>
          ),
        )}
      </div>
    ) : null}
  </div>
)}
```

(Import `FileText` from `lucide-react` if not already imported.)

- [ ] **Step 5: Typecheck + lint + render test**

Add a render test asserting a user message with one image + one PDF attachment renders an `<img>` to `/api/attachments/<id>` and a file chip with the filename (Vitest + the project's React testing setup, mirroring an existing SessionView render test).
Run: `bun run typecheck && bun run test --filter @opencompany/web -- SessionView && bunx biome check apps/web`
Expected: PASS.

- [ ] **Step 6: Commit (local)**

```bash
git add apps/web/app/api/attachments apps/web/lib/agent-sessions apps/web/components/SessionView.tsx
git commit -m "feat(attachments): serve + render message attachments in the thread"
```

---

## Task 10: Full local verification + browser QA (before any PR)

**No code — this is the gate the user requires before a PR exists.**

- [ ] **Step 1: Green checks locally**

Run: `bun run test && bun run lint && bunx biome check . && bun run typecheck`
Expected: all PASS. (Reminder: `bun run lint` is ESLint only — `biome check .` is the CI formatting/import-order gate.)

- [ ] **Step 2: Migrate the local DB**

Run: `bun run db:migrate`
Expected: the attachments table exists.

- [ ] **Step 3: Boot the dev server (no infisical) on :3000 for login-gated QA**

Per the OpenCompany QA convention: ensure `.env.local` + `.env.override.local` are present, then `cd apps/web && PORT=3000 bun run dev`. Ensure `BLOB_READ_WRITE_TOKEN` (private store) is set locally. Grep the log for DB auth errors = 0.

- [ ] **Step 4: Click through the acceptance criteria (real browser, Playwright session)**

- Paste a screenshot into the composer → thumbnail chip appears with progress → ready. Send → image renders in the user bubble in the thread → the model's reply references the image content.
- Drag-drop a PDF → file chip → send → chip renders in thread → model reads the PDF.
- Use the "+" → file-picker → select an image → same flow.
- A session whose model is text-only (no `supportsImages`/`supportsPdf`) → attach "+" is disabled with the tooltip; paste/drop are ignored.
- Oversized file (>25 MB) and unsupported type → inline rejection, other attachments unaffected.
- Capture screenshots of the working flow for the PR body.

- [ ] **Step 5: Report results to the user**

Summarize pass/fail per criterion with screenshots. Only after the user confirms QA is good do we proceed to the PR step (squash, draft PR with QA checklist + screenshots, `@vercel/blob` env setup confirmed in Infisical/Vercel). Per the user's standing rule, the first real code task pauses for the user to test/commit before any autopilot.

---

## Self-Review (completed during authoring)

- **Spec coverage:** storage (Tasks 4,5), data model (Task 3), capability metadata + gate (Tasks 2,6,7), upload flow (Tasks 5,6), submit/persist (Task 7), runner base64-inline parts (Task 8), rendering + serve route (Task 9), errors/limits (Tasks 1,6,7), setup (Task 4), tests/QA (Tasks 1,2,8,9,10), out-of-scope respected (no model picker, no editing, no OCR). ✓
- **Placeholder scan:** No "TODO/TBD implement-later" logic gaps. Two explicit *verification* notes (Blob private `access`/download API; AI SDK v6 base64 vs data-URL) flag fast-moving external APIs to confirm via context7 at implementation — these are confirmations, not missing logic.
- **Type consistency:** `PendingAttachment`, `SubmitAttachmentInput`, `ReplayAttachment`, and the `agentSessionMessageAttachments` columns share field names (`kind`, `mediaType`, `filename`, `sizeBytes`, `blobPathname`, `blobUrl`). `modelSupportsAttachments` returns `{ images, pdf }` everywhere. `validateAttachmentCandidate` returns `{ ok, kind }` used consistently in web + server.
