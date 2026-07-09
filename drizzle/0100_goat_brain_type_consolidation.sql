-- Goat Brain type consolidation: 10 entity types -> 8.
-- media/email -> source (external artifacts; the source ref's provider carries
-- the format nuance), writing -> analysis (synthesized prose), and meeting is
-- promoted from a folder convention to a real type (Jamie meeting pages and
-- their transcript evidence adopt it). Also strips the retired `tags:`
-- frontmatter block, which the parser no longer reads.
-- Replacement strings need real newline characters: \n escapes are only
-- interpreted on the pattern side of regexp_replace.
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_entity_type_check";
--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "entity_type" = 'source',
  "content" = regexp_replace("content", E'(^|\\n)type: (media|email)(\\n)', E'\\1type: source\\3')
WHERE "entity_type" IN ('media', 'email');
--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "entity_type" = 'analysis',
  "content" = regexp_replace("content", E'(^|\\n)type: writing(\\n)', E'\\1type: analysis\\2')
WHERE "entity_type" = 'writing';
--> statement-breakpoint
-- Jamie meeting pages (deterministic pre-writes landed in meetings/ as note).
UPDATE "goat"."brain_documents"
SET
  "entity_type" = 'meeting',
  "content" = regexp_replace("content", E'(^|\\n)type: note(\\n)', E'\\1type: meeting\\2')
WHERE
  "entity_type" = 'note'
  AND ("folder_path" = 'meetings' OR "folder_path" LIKE 'meetings/%')
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("sources") AS source_entry
    WHERE source_entry->>'ref' LIKE 'jamie:%'
  );
--> statement-breakpoint
-- Jamie transcript evidence records (pre-written as source in the evidence zone).
UPDATE "goat"."brain_documents"
SET
  "entity_type" = 'meeting',
  "content" = regexp_replace("content", E'(^|\\n)type: source(\\n)', E'\\1type: meeting\\2')
WHERE
  "kind" = 'evidence'
  AND "entity_type" = 'source'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("sources") AS source_entry
    WHERE source_entry->>'ref' LIKE 'jamie:%'
  );
--> statement-breakpoint
-- Tags were removed from the contract: drop the frontmatter block list.
UPDATE "goat"."brain_documents"
SET "content" = regexp_replace("content", E'(^|\\n)tags:\\n(([ \\t]+- [^\\n]*)(\\n|$))+', E'\\1')
WHERE "content" ~ E'(^|\\n)tags:\\n[ \\t]+- ';
--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "content_hash" = encode(sha256(convert_to("content", 'UTF8')), 'hex'),
  "size_bytes" = octet_length("content");
--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_entity_type_check" CHECK ("entity_type" IN ('person', 'company', 'project', 'meeting', 'concept', 'source', 'analysis', 'note'));
--> statement-breakpoint
-- Versions store frontmatter only inside content; rewrite the retired type
-- names the same way (folder-based meeting retyping is skipped here: versions
-- are an audit trail and legacy aliases in the parser cover reads).
UPDATE "goat"."brain_document_versions"
SET "content" = regexp_replace(
  regexp_replace(
    regexp_replace("content", E'(^|\\n)type: (media|email)(\\n)', E'\\1type: source\\3'),
    E'(^|\\n)type: writing(\\n)',
    E'\\1type: analysis\\2'
  ),
  E'(^|\\n)tags:\\n(([ \\t]+- [^\\n]*)(\\n|$))+',
  E'\\1'
)
WHERE "content" ~ E'(^|\\n)(type: (media|email|writing)\\n|tags:\\n[ \\t]+- )';
--> statement-breakpoint
UPDATE "goat"."brain_document_versions"
SET
  "content_hash" = encode(sha256(convert_to("content", 'UTF8')), 'hex'),
  "size_bytes" = octet_length("content")
WHERE "content" <> '';
