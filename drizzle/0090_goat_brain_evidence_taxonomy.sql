ALTER TABLE "goat"."brain_documents" ADD COLUMN "evidence_kind" text;
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_entity_type_check";
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_folder_entity_type_check";
--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "folder_path" = CASE
    WHEN "folder_path" = 'conversations' THEN 'evidence/chat'
    WHEN "folder_path" LIKE 'conversations/%' THEN 'evidence/chat/' || substring("folder_path" from 15)
    ELSE "folder_path"
  END,
  "entity_type" = 'evidence',
  "evidence_kind" = 'chat',
  "content" = regexp_replace(
    regexp_replace(
      "content",
      E'(^|\\n)folder: conversations([^\\n]*)',
      E'\\1folder: evidence/chat\\2',
      'g'
    ),
    E'(^|\\n)type: conversation(\\n)',
    E'\\1type: evidence\\nevidenceKind: chat\\2',
    'g'
  )
WHERE "folder_path" = 'conversations'
  OR "folder_path" LIKE 'conversations/%'
  OR "entity_type" = 'conversation';
--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "folder_path" = CASE
    WHEN "folder_path" = 'docs' THEN 'evidence/document'
    WHEN "folder_path" LIKE 'docs/%' THEN 'evidence/document/' || substring("folder_path" from 6)
    ELSE "folder_path"
  END,
  "entity_type" = 'evidence',
  "evidence_kind" = 'document',
  "content" = regexp_replace(
    regexp_replace(
      "content",
      E'(^|\\n)folder: docs([^\\n]*)',
      E'\\1folder: evidence/document\\2',
      'g'
    ),
    E'(^|\\n)type: document(\\n)',
    E'\\1type: evidence\\nevidenceKind: document\\2',
    'g'
  )
WHERE "folder_path" = 'docs'
  OR "folder_path" LIKE 'docs/%'
  OR "entity_type" = 'document';
--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "folder_path" = CASE
    WHEN "folder_path" = 'references' THEN 'evidence/document'
    WHEN "folder_path" LIKE 'references/%' THEN 'evidence/document/' || substring("folder_path" from 12)
    ELSE "folder_path"
  END,
  "entity_type" = 'evidence',
  "evidence_kind" = 'document',
  "content" = regexp_replace(
    regexp_replace(
      "content",
      E'(^|\\n)folder: references([^\\n]*)',
      E'\\1folder: evidence/document\\2',
      'g'
    ),
    E'(^|\\n)type: reference(\\n)',
    E'\\1type: evidence\\nevidenceKind: document\\2',
    'g'
  )
WHERE "folder_path" = 'references'
  OR "folder_path" LIKE 'references/%'
  OR "entity_type" = 'reference';
--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "folder_path" = CASE
    WHEN "folder_path" = 'daily' THEN 'inbox/daily'
    WHEN "folder_path" LIKE 'daily/%' THEN 'inbox/daily/' || substring("folder_path" from 7)
    ELSE "folder_path"
  END,
  "entity_type" = 'note',
  "evidence_kind" = NULL,
  "content" = regexp_replace(
    regexp_replace(
      "content",
      E'(^|\\n)folder: daily([^\\n]*)',
      E'\\1folder: inbox/daily\\2',
      'g'
    ),
    E'(^|\\n)type: daily(\\n)',
    E'\\1type: note\\2',
    'g'
  )
WHERE "folder_path" = 'daily'
  OR "folder_path" LIKE 'daily/%'
  OR "entity_type" = 'daily';
--> statement-breakpoint
UPDATE "goat"."brain_document_versions"
SET
  "folder_path" = CASE
    WHEN "folder_path" = 'conversations' THEN 'evidence/chat'
    WHEN "folder_path" LIKE 'conversations/%' THEN 'evidence/chat/' || substring("folder_path" from 15)
    WHEN "folder_path" = 'docs' THEN 'evidence/document'
    WHEN "folder_path" LIKE 'docs/%' THEN 'evidence/document/' || substring("folder_path" from 6)
    WHEN "folder_path" = 'references' THEN 'evidence/document'
    WHEN "folder_path" LIKE 'references/%' THEN 'evidence/document/' || substring("folder_path" from 12)
    WHEN "folder_path" = 'daily' THEN 'inbox/daily'
    WHEN "folder_path" LIKE 'daily/%' THEN 'inbox/daily/' || substring("folder_path" from 7)
    ELSE "folder_path"
  END,
  "content" = regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  "content",
                  E'(^|\\n)folder: conversations([^\\n]*)',
                  E'\\1folder: evidence/chat\\2',
                  'g'
                ),
                E'(^|\\n)type: conversation(\\n)',
                E'\\1type: evidence\\nevidenceKind: chat\\2',
                'g'
              ),
              E'(^|\\n)folder: docs([^\\n]*)',
              E'\\1folder: evidence/document\\2',
              'g'
            ),
            E'(^|\\n)type: document(\\n)',
            E'\\1type: evidence\\nevidenceKind: document\\2',
            'g'
          ),
          E'(^|\\n)folder: references([^\\n]*)',
          E'\\1folder: evidence/document\\2',
          'g'
        ),
        E'(^|\\n)type: reference(\\n)',
        E'\\1type: evidence\\nevidenceKind: document\\2',
        'g'
      ),
      E'(^|\\n)folder: daily([^\\n]*)',
      E'\\1folder: inbox/daily\\2',
      'g'
    ),
    E'(^|\\n)type: daily(\\n)',
    E'\\1type: note\\2',
    'g'
  )
WHERE "folder_path" = 'conversations'
  OR "folder_path" LIKE 'conversations/%'
  OR "folder_path" = 'docs'
  OR "folder_path" LIKE 'docs/%'
  OR "folder_path" = 'references'
  OR "folder_path" LIKE 'references/%'
  OR "folder_path" = 'daily'
  OR "folder_path" LIKE 'daily/%';
--> statement-breakpoint
DELETE FROM "goat"."brain_folders"
WHERE "path" = 'conversations'
  OR "path" LIKE 'conversations/%'
  OR "path" = 'docs'
  OR "path" LIKE 'docs/%'
  OR "path" = 'references'
  OR "path" LIKE 'references/%'
  OR "path" = 'daily'
  OR "path" LIKE 'daily/%';
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_entity_type_check" CHECK ("entity_type" IN ('person', 'company', 'project', 'decision', 'meeting', 'research', 'concept', 'evidence', 'note'));
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_evidence_kind_check" CHECK (
  ("entity_type" = 'evidence' AND (
    ("evidence_kind" = 'chat' AND ("folder_path" = 'evidence/chat' OR "folder_path" LIKE 'evidence/chat/%')) OR
    ("evidence_kind" = 'email' AND ("folder_path" = 'evidence/email' OR "folder_path" LIKE 'evidence/email/%')) OR
    ("evidence_kind" = 'correction' AND ("folder_path" = 'evidence/correction' OR "folder_path" LIKE 'evidence/correction/%')) OR
    ("evidence_kind" = 'document' AND ("folder_path" = 'evidence/document' OR "folder_path" LIKE 'evidence/document/%'))
  )) OR
  ("entity_type" <> 'evidence' AND "evidence_kind" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_folder_entity_type_check" CHECK (
  ("entity_type" = 'person' AND ("folder_path" = 'people' OR "folder_path" LIKE 'people/%')) OR
  ("entity_type" = 'company' AND ("folder_path" = 'companies' OR "folder_path" LIKE 'companies/%')) OR
  ("entity_type" = 'project' AND ("folder_path" = 'projects' OR "folder_path" LIKE 'projects/%')) OR
  ("entity_type" = 'decision' AND ("folder_path" = 'decisions' OR "folder_path" LIKE 'decisions/%')) OR
  ("entity_type" = 'meeting' AND ("folder_path" = 'meetings' OR "folder_path" LIKE 'meetings/%')) OR
  ("entity_type" = 'research' AND ("folder_path" = 'research' OR "folder_path" LIKE 'research/%')) OR
  ("entity_type" = 'concept' AND ("folder_path" = 'concepts' OR "folder_path" LIKE 'concepts/%')) OR
  ("entity_type" = 'evidence' AND (
    "folder_path" = 'evidence/chat' OR "folder_path" LIKE 'evidence/chat/%' OR
    "folder_path" = 'evidence/email' OR "folder_path" LIKE 'evidence/email/%' OR
    "folder_path" = 'evidence/correction' OR "folder_path" LIKE 'evidence/correction/%' OR
    "folder_path" = 'evidence/document' OR "folder_path" LIKE 'evidence/document/%'
  )) OR
  ("entity_type" = 'note' AND ("folder_path" = 'inbox' OR "folder_path" LIKE 'inbox/%'))
);
