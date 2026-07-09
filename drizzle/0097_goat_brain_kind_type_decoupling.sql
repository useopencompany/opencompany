-- Goat Brain Step 1: decouple type from folder, make evidence a zone.
-- New contract: `kind` (page|evidence) marks the zone (evidence docs live under
-- evidence/), `entity_type` becomes a pure tag from a new 10-value set, and
-- folders are free-form navigation. The old file-format `kind` column is
-- renamed to `format`; `evidence_kind` is dropped.
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_kind_check";
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_entity_type_check";
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_evidence_kind_check";
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_folder_entity_type_check";
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" RENAME COLUMN "kind" TO "format";
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN "kind" text;
--> statement-breakpoint
-- Retype retired entity types (decision/meeting -> note, research -> analysis)
-- in both the column and the embedded frontmatter.
UPDATE "goat"."brain_documents"
SET
  "entity_type" = 'analysis',
  "content" = regexp_replace("content", E'(^|\\n)type: research(\\n)', E'\\1type: analysis\\2')
WHERE "entity_type" = 'research';
--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "entity_type" = 'note',
  "content" = regexp_replace("content", E'(^|\\n)type: decision(\\n)', E'\\1type: note\\2')
WHERE "entity_type" = 'decision';
--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "entity_type" = 'note',
  "content" = regexp_replace("content", E'(^|\\n)type: meeting(\\n)', E'\\1type: note\\2')
WHERE "entity_type" = 'meeting';
--> statement-breakpoint
-- Evidence stops being a type: map by old evidence_kind (email -> email,
-- correction -> note, chat/document -> source) and strip the evidenceKind line.
UPDATE "goat"."brain_documents"
SET
  "entity_type" = CASE "evidence_kind"
    WHEN 'email' THEN 'email'
    WHEN 'correction' THEN 'note'
    ELSE 'source'
  END,
  "content" = regexp_replace(
    regexp_replace(
      "content",
      E'(^|\\n)type: evidence(\\n)',
      E'\\1type: ' || CASE "evidence_kind"
        WHEN 'email' THEN 'email'
        WHEN 'correction' THEN 'note'
        ELSE 'source'
      END || E'\\2'
    ),
    E'(^|\\n)evidenceKind: [a-z]+\\n',
    E'\\1'
  )
WHERE "entity_type" = 'evidence';
--> statement-breakpoint
-- Kind is the zone marker: evidence/ tree = evidence, everything else = page.
UPDATE "goat"."brain_documents"
SET "kind" = CASE
  WHEN "folder_path" = 'evidence' OR "folder_path" LIKE 'evidence/%' THEN 'evidence'
  ELSE 'page'
END;
--> statement-breakpoint
-- Insert the kind frontmatter line ahead of the type line (first match only).
-- Replacement strings need real newline characters: \n escapes are only
-- interpreted on the pattern side of regexp_replace.
UPDATE "goat"."brain_documents"
SET "content" = regexp_replace("content", E'\\ntype: ', E'\nkind: ' || "kind" || E'\ntype: ')
WHERE "content" !~ E'(^|\\n)kind: (page|evidence)\\n';
--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "content_hash" = encode(sha256(convert_to("content", 'UTF8')), 'hex'),
  "size_bytes" = octet_length("content");
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ALTER COLUMN "kind" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP COLUMN "evidence_kind";
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_format_check" CHECK ("format" IN ('markdown', 'pdf', 'docx'));
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_kind_check" CHECK ("kind" IN ('page', 'evidence'));
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_entity_type_check" CHECK ("entity_type" IN ('person', 'company', 'media', 'analysis', 'concept', 'email', 'writing', 'note', 'project', 'source'));
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_kind_zone_check" CHECK (
  ("kind" = 'evidence' AND ("folder_path" = 'evidence' OR "folder_path" LIKE 'evidence/%')) OR
  ("kind" = 'page' AND "folder_path" <> 'evidence' AND "folder_path" NOT LIKE 'evidence/%')
);
--> statement-breakpoint
-- Versions store frontmatter only inside content; rewrite it the same way.
UPDATE "goat"."brain_document_versions"
SET "content" = regexp_replace(
  regexp_replace(
    regexp_replace(
      CASE
        WHEN "content" ~ E'(^|\\n)type: evidence(\\n)' THEN regexp_replace(
          regexp_replace(
            "content",
            E'(^|\\n)type: evidence(\\n)',
            E'\\1type: ' || CASE
              WHEN "content" ~ E'(^|\\n)evidenceKind: email(\\n)' THEN 'email'
              WHEN "content" ~ E'(^|\\n)evidenceKind: correction(\\n)' THEN 'note'
              ELSE 'source'
            END || E'\\2'
          ),
          E'(^|\\n)evidenceKind: [a-z]+\\n',
          E'\\1'
        )
        ELSE "content"
      END,
      E'(^|\\n)type: research(\\n)',
      E'\\1type: analysis\\2'
    ),
    E'(^|\\n)type: decision(\\n)',
    E'\\1type: note\\2'
  ),
  E'(^|\\n)type: meeting(\\n)',
  E'\\1type: note\\2'
)
WHERE "content" ~ E'(^|\\n)type: (evidence|research|decision|meeting)(\\n)';
--> statement-breakpoint
UPDATE "goat"."brain_document_versions"
SET "content" = regexp_replace(
  "content",
  E'\\ntype: ',
  E'\nkind: ' || CASE
    WHEN "folder_path" = 'evidence' OR "folder_path" LIKE 'evidence/%' THEN 'evidence'
    ELSE 'page'
  END || E'\ntype: '
)
WHERE "content" ~ E'(^|\\n)type: ' AND "content" !~ E'(^|\\n)kind: (page|evidence)\\n';
--> statement-breakpoint
UPDATE "goat"."brain_document_versions"
SET
  "content_hash" = encode(sha256(convert_to("content", 'UTF8')), 'hex'),
  "size_bytes" = octet_length("content")
WHERE "content" <> '';
