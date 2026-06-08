# Screenshots & PDFs in den Session-Composer einfügen

- **Date:** 2026-06-05
- **Status:** Approved design (pre-implementation)
- **Branch:** `screenshot-paste-feature`
- **Author:** Jasper Kallfelz

## Problem & Goal

Users müssen Screenshots (und PDFs) direkt in den Composer einer AI-Agent-Session
einfügen können — wie bei ChatGPT: Bild anhängen, Vorschau sehen, abschicken, und das
Modell *sieht* den Inhalt. Heute existiert das UI-Gerüst (Paste-/Drop-/Picker-Handler),
zeigt aber nur „coming soon"-Toasts. Es fehlt die komplette Backend-Verdrahtung.

"Multimodal" heißt hier konkret: das Attachment wird **im Thread angezeigt** *und* als
Image-/File-Part **ans Modell** geschickt (ChatGPT-Style).

## Decisions (locked)

| Thema | Entscheidung |
|---|---|
| Zweck | Multimodal — anzeigen **und** ans Modell senden |
| Eingabewege | Paste (⌘V) + Drag-&-Drop + File-Picker (alle drei) |
| Dateitypen | Bilder (PNG/JPG/WebP/GIF) **und** PDF |
| Storage | **Vercel Blob, privater Store** |
| Bytes → Modell | **base64-inline** (Runner holt Bytes mit Token, hängt inline an; keine URL zum Provider) |
| Datenmodell | **Eigene Tabelle** `agent_session_message_attachments` |
| Modell-Gating | Attach **gegated** an Capability; inkompatibles Modell → Attach deaktiviert + Tooltip (kein Picker, kein „neue Session"-Button) |
| Limits (v1) | max **25 MB/Datei**, max **10 Dateien/Message** |

### Rationale für die nicht-offensichtlichen Entscheidungen
- **Privater Blob-Store statt public+unguessable:** Screenshots sind workspace-privat.
  Public-mit-Random-Suffix ist „secret by obscurity"; ein privater Store + auth-gescopte
  Serve-Route ist die saubere Wahl (analog zum bestehenden Avatar-Pattern).
- **base64-inline statt URL ans Modell:** Ein privater Blob ist für die Provider-Server
  nicht erreichbar (403). base64-inline ist provider-portabel über das Vercel AI Gateway
  und leakt nichts. Kosten: Payload ~33% größer — durch das 25-MB-Limit eingegrenzt.
- **Eigene Tabelle statt JSONB-Spalte:** Sauberer Blob-Lifecycle (Orphan-/Cascade-Löschen
  der Blobs) und einfacheres Rendering/Querying.

## Existing surface (Ist-Zustand)

| Aspekt | Fundstelle | Zustand |
|---|---|---|
| Composer | `apps/web/components/SessionView.tsx` (`SessionViewContentBody`) | `<textarea>`, `input`-State (Z. 265) |
| Paste-Handler | `SessionView.tsx:1077-1098` | erkennt Bilder → „Image upload coming soon"-Toast |
| Drag-&-Drop + Overlay | `SessionView.tsx:855-896` | Overlay „PNG, JPG, PDF · or paste with ⌘V" → Toast |
| Attach-Menü („+") | `SessionView.tsx:991-1025` | „Upload file" → Toast |
| Message-Render | `SessionView.tsx:464-525` (User: nur `message.content`, Z. 504) | keine Attachment-Darstellung |
| Submit (Client) | `SessionView.tsx:777-822` (`submit()`/`handleSend()`) | ruft Server-Action mit `content` |
| Submit (Server-Action) | `apps/web/lib/agent-sessions/actions.ts:159` `submitAgentSessionMessage(sessionId, content)` | `insertUserMessage` (Z. 733-784) → DB → `triggerAgentMessageRun` in `after()` (Z. 225-241) |
| Message-Schema | `packages/db/src/schema.ts:524-552` (`agentSessionMessages`) | `content` text, `modelMessage` jsonb; keine Attachments |
| Session-Modell | `packages/db/src/schema.ts:363-364` (`modelProvider`/`modelName`, default `openai/gpt-5.4-mini`) | fix nach Session-Erstellung, **kein Picker** |
| Modell-Katalog | `packages/agent-runtime/src/models.ts` (`AGENT_MODEL_CATALOG`, `AgentModelDefinition`) | **nur** `supportsReasoning`; **keine** Vision/PDF-Flags |
| Runner-Messagebau | `apps/runner/src/model-messages.ts:28-69` (`buildModelMessages`) | nur Text + Tool/Reasoning |
| Modellaufruf | `apps/runner/src/model-turn.ts:85-96` (`streamText({ model: gateway(...), messages })`) | Text-only Messages |
| Binär-Vorbild | `apps/web/app/api/avatar/[userId]/route.ts` (+ `userAvatars` bytea) | auth-gescopte Serve-Route, Cache-Busting `?v=` |

## Architecture (Datenfluss)

```
Composer (SessionView)        Upload → Blob               Submit                 Runner
────────────────────────      ─────────────────────       ─────────────────      ─────────────────────────
Paste/Drop/Picker → Gate      upload() (@vercel/blob/      submitAgentSession     buildModelMessages lädt
prüft Modell-Capability;      client) → POST /api/upload   Message(id, text,      Attachment-Rows; holt Bytes
Datei sofort hochladen        (handleUpload: authn,        attachments[]) →       aus privatem Blob (Token);
(optimistisch, Thumbnail +    contentTypes+size limit,     insertUserMessage      base64/Buffer-inline als
Progress)                     privater Store)              schreibt msg + rows    image/file-Part → streamText
```

## Detailed design

### 1. Datenmodell (`packages/db`)
Neue Tabelle **`agent_session_message_attachments`**:
- `id` (text, PK), `messageId` (FK → `agentSessionMessages.id`, cascade delete),
  `sessionId`, `workspaceId`, `kind` (`'image' | 'pdf'`), `mediaType` (text),
  `filename` (text), `sizeBytes` (integer), `blobPathname` (text), `blobUrl` (text),
  `createdAt` (timestamptz, default now).
- Index auf `messageId` (Rendering-Query) und `sessionId` (Cleanup).
- Migration via `bun run db:generate` (Drizzle). QA muss `bun run db:migrate` laufen lassen.

### 2. Capability-Metadaten (`packages/agent-runtime/src/models.ts`)
- `AgentModelDefinition` erweitern: `supportsImages?: boolean`, `supportsPdf?: boolean`.
- Katalog-Einträge pflegen (vision-fähige Modelle = true; restliche = false/undefined).
- Helper `modelSupportsAttachments(modelName): { images: boolean; pdf: boolean }`
  (exportiert, von Client-Gate und Server-Validierung genutzt).

### 3. Upload-Route (`apps/web/app/api/upload/route.ts`)
- `handleUpload` aus `@vercel/blob/client`.
- `onBeforeGenerateToken`: `currentWorkspace()` authentifizieren; Pathname
  `workspace/<wsId>/sessions/<sessionId>/<random>.<ext>`; `allowedContentTypes` =
  Bild-Set + `application/pdf`; `maximumSizeInBytes` = 25 MB; **privater Store**;
  `addRandomSuffix: true`.
- `onUploadCompleted`: feuert nicht auf localhost → wir persistieren **nicht** hier,
  sondern beim Submit. (Route bleibt schlank; DB-Schreibung im Submit-Pfad.)

### 4. Composer (`apps/web/components/SessionView.tsx`)
- Neuer State `attachments: PendingAttachment[]` neben `input` (Z. ~265):
  `{ id, file, kind, mediaType, filename, sizeBytes, status: 'uploading'|'ready'|'error',
  blobPathname?, blobUrl?, previewUrl?, error? }`.
- **Paste/Drop/Picker** (Z. 1077 / 855 / 991): Toasts ersetzen → validieren (Typ/Größe/
  Anzahl) → `upload()` → State auf `ready` mit `blobUrl`. Bild: `FileReader`-Vorschau;
  PDF: Datei-Chip mit Name. Entfernen-Button → `del()` + State raus.
- **Gate:** `modelSupportsAttachments(session.modelName)` false → Attach-Button disabled,
  Paste/Drop ignorieren, Tooltip „Das Modell dieser Session unterstützt keine Uploads."
- **Senden** nur wenn alle `attachments` `ready` (sonst Button disabled).

### 5. Submit + Persistenz (`apps/web/lib/agent-sessions/actions.ts`)
- `submitAgentSessionMessage(sessionId, content, attachments?)` — `attachments` =
  `[{ blobPathname, blobUrl, kind, mediaType, filename, sizeBytes }]`.
- **Server-seitige Re-Validierung** (Client-Limits nicht vertrauen): Workspace-Scope des
  Pathname, erlaubte mediaTypes, Größe, Anzahl ≤ 10, Modell-Capability.
- `insertUserMessage` schreibt Message **und** Attachment-Rows in einem `db.batch`.

### 6. Runner (`apps/runner/src/model-messages.ts`)
- Pro User-Message zugehörige Attachment-Rows laden.
- Hat eine Message Attachments → `content` wird zum Parts-Array:
  `{ type:'text', text }` + pro Attachment `{ type:'image', image: <base64>, mediaType }`
  bzw. `{ type:'file', data: <base64/Buffer>, mediaType:'application/pdf', filename }`.
- Bytes aus dem privaten Blob-Store holen (Runner hält `BLOB_READ_WRITE_TOKEN`),
  **inline** anhängen. Keine URL zum Provider.

### 7. Rendering im Thread (`apps/web/components/SessionView.tsx:504`)
- User-Message unter dem Text: Bilder als Thumbnail (Klick öffnet groß), PDFs als Chip
  (Dateiname + Download).
- **Serve-Route `apps/web/app/api/attachments/[id]/route.ts`** (analog Avatar): prüft
  Workspace-Zugehörigkeit und **streamt die Bytes** aus dem privaten Blob-Store (mit Token),
  mit Cache-Header. **Nie** roher privater Blob-Link im DOM. (Keine signed/öffentliche URL —
  konsistent mit der „keine öffentliche URL"-Linie.)
- `detail.messages`-Query muss Attachments mitladen; `SessionMessage`-Type
  (`apps/web/lib/agent-sessions/runtime-events.ts`) um `attachments?` erweitern.

### 8. Fehler & Limits
Zu groß / falscher Typ / zu viele → Inline-Fehler am Chip, blockiert nicht die anderen
Anhänge. Upload-Fehler → Retry am Chip. Timeout → klare Meldung. Server lehnt nicht
erlaubte Typen/Größen hart ab (kein Bypass über manipulierten Client).

### 9. Setup-Schritt (vor Merge)
- `@vercel/blob` als Dependency (`apps/web` + `apps/runner`).
- `BLOB_READ_WRITE_TOKEN` (privater Store) in **Infisical dev + prod** + Vercel-Env.
- `.env.example` ergänzen.

### 10. Tests / QA
- **Unit (Vitest):** `modelSupportsAttachments`; Attachment-Validierung (Typ/Größe/Anzahl);
  `buildModelMessages` mit Image- + PDF-Parts.
- **Render:** Composer-Chips (uploading/ready/error), Gate-Disable, User-Message mit
  Attachments.
- **Echte Browser-QA:** Screenshot pasten → Thumbnail → senden → erscheint im Thread →
  Modell reagiert auf Bildinhalt; PDF droppen → Chip → Modell liest PDF; Text-only-Modell
  → Attach disabled + Tooltip. Screenshot an PR-Body.

## Out of scope (v1, bewusst)
Kein Modell-Picker · keine Bild-Bearbeitung/Crop · kein Audio/Video · keine Attachments an
Assistant-Messages · kein OCR-Preprocessing (Modelle lesen PDF direkt) · keine
Lightbox-Galerie (simples Öffnen reicht).

## Risks / open notes
- **`onUploadCompleted` feuert lokal nicht** → DB-Persist bewusst in den Submit-Pfad
  verlagert (nicht in den Blob-Callback). Lokale QA dadurch unproblematisch.
- **Capability-Pflege:** Vision/PDF-Flags pro Modell müssen korrekt gesetzt sein; bei neuen
  Modellen mitpflegen, sonst falsches Gating.
- **Payload-Größe:** große PDFs base64-inline können Token-/Request-Limits treffen — 25-MB-
  Cap mildert das; ggf. später signed-URL-Pfad als Option.

## Concrete file-touch list
- `packages/db/src/schema.ts` (+ neue Drizzle-Migration)
- `packages/agent-runtime/src/models.ts`
- `apps/web/app/api/upload/route.ts` (neu)
- `apps/web/app/api/attachments/[id]/route.ts` (neu)
- `apps/web/components/SessionView.tsx`
- `apps/web/lib/agent-sessions/actions.ts`
- `apps/web/lib/agent-sessions/runtime-events.ts`
- `apps/runner/src/model-messages.ts`
- `apps/web/package.json` + `apps/runner/package.json` (`@vercel/blob`)
- `.env.example`
