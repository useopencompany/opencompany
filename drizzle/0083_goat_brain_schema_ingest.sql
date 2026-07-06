ALTER TABLE "goat"."brain_documents" ADD COLUMN "schema_type" text DEFAULT 'note' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET "schema_type" = CASE split_part("folder_path", '/', 1)
  WHEN 'people' THEN 'person'
  WHEN 'companies' THEN 'company'
  WHEN 'projects' THEN 'project'
  WHEN 'meetings' THEN 'meeting'
  WHEN 'decisions' THEN 'decision'
  WHEN 'insights' THEN 'insight'
  WHEN 'research' THEN 'research'
  WHEN 'references' THEN 'reference'
  WHEN 'docs' THEN 'reference'
  ELSE 'note'
END;
