CREATE TABLE "inbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_session_id" text,
	"source" text,
	"title" text NOT NULL,
	"body" text,
	"steps" jsonb,
	"priority" text,
	"due_at" timestamp with time zone,
	"artifact" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"dedup_key" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "inbox_items_status_check" CHECK ("inbox_items"."status" IN ('open', 'snoozed', 'done', 'dismissed')),
	CONSTRAINT "inbox_items_priority_check" CHECK ("inbox_items"."priority" IS NULL OR "inbox_items"."priority" IN ('urgent', 'high', 'med', 'low'))
);
--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_source_session_id_agent_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_items_workspace_user_idx" ON "inbox_items" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "inbox_items_status_idx" ON "inbox_items" USING btree ("workspace_id","user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_items_dedup_idx" ON "inbox_items" USING btree ("workspace_id","user_id","dedup_key") WHERE "inbox_items"."dedup_key" IS NOT NULL AND "inbox_items"."status" IN ('open', 'snoozed');