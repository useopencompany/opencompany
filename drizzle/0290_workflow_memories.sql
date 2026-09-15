-- A workflow's single markdown memory, carried between runs. Additive: existing workflows have no
-- row until memory is toggled on, which reads as disabled with empty content.
CREATE TABLE "goat"."workflow_memories" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."workflow_memories"
	ADD CONSTRAINT "workflow_memories_workflow_id_workflows_id_fk"
	FOREIGN KEY ("workflow_id") REFERENCES "goat"."workflows"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."workflow_memories"
	ADD CONSTRAINT "workflow_memories_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "opencompany_workflow_memories_workspace_idx"
	ON "goat"."workflow_memories" USING btree ("workspace_id");
