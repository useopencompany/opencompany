CREATE TABLE "goat"."brain_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"document_id" text NOT NULL,
	"from_brain_id" text NOT NULL,
	"to_brain_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"source_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_brain_edges_source_kind_check" CHECK ("goat"."brain_edges"."source_kind" IN ('relation', 'wiki_link'))
);
--> statement-breakpoint
ALTER TABLE "goat"."brain_edges" ADD CONSTRAINT "brain_edges_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."brain_edges" ADD CONSTRAINT "brain_edges_document_id_brain_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "goat"."brain_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goat_brain_edges_document_idx" ON "goat"."brain_edges" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "goat_brain_edges_user_from_idx" ON "goat"."brain_edges" USING btree ("user_workos_id","from_brain_id");--> statement-breakpoint
CREATE INDEX "goat_brain_edges_user_to_idx" ON "goat"."brain_edges" USING btree ("user_workos_id","to_brain_id");--> statement-breakpoint
CREATE INDEX "goat_brain_edges_user_relation_idx" ON "goat"."brain_edges" USING btree ("user_workos_id","relation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_edges_unique_idx" ON "goat"."brain_edges" USING btree ("user_workos_id","document_id","from_brain_id","to_brain_id","relation_type","source_kind");--> statement-breakpoint
INSERT INTO "goat"."brain_edges" (
	"id",
	"user_workos_id",
	"document_id",
	"from_brain_id",
	"to_brain_id",
	"relation_type",
	"source_kind",
	"created_at",
	"updated_at"
)
SELECT DISTINCT
	'goat_brain_edge_' || md5(document."id" || ':relation:' || COALESCE(relation.value->>'type', 'related') || ':' || (relation.value->>'to')),
	document."user_workos_id",
	document."id",
	document."brain_id",
	relation.value->>'to',
	COALESCE(NULLIF(relation.value->>'type', ''), 'related'),
	'relation',
	document."updated_at",
	document."updated_at"
FROM "goat"."brain_documents" AS document
CROSS JOIN LATERAL jsonb_array_elements(document."relations") AS relation(value)
WHERE relation.value->>'to' ~ '^[a-z0-9][a-z0-9-]{0,79}$'
	AND COALESCE(NULLIF(relation.value->>'type', ''), 'related') ~ '^[a-z][a-z0-9_]*$'
	AND relation.value->>'to' <> document."brain_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "goat"."brain_edges" (
	"id",
	"user_workos_id",
	"document_id",
	"from_brain_id",
	"to_brain_id",
	"relation_type",
	"source_kind",
	"created_at",
	"updated_at"
)
SELECT DISTINCT
	'goat_brain_edge_' || md5(document."id" || ':wiki_link:' || wiki.target),
	document."user_workos_id",
	document."id",
	document."brain_id",
	wiki.target,
	'wiki_link',
	'wiki_link',
	document."updated_at",
	document."updated_at"
FROM "goat"."brain_documents" AS document
CROSS JOIN LATERAL (
	SELECT (regexp_matches(document."body", '\[\[([^[\]\n|]+)(?:\|[^[\]\n]+)?\]\]', 'g'))[1] AS target
) AS wiki
WHERE wiki.target ~ '^[a-z0-9][a-z0-9-]{0,79}$'
	AND wiki.target <> document."brain_id"
ON CONFLICT DO NOTHING;
