-- Sidebar Projects: named folders that group a member's chats and Tasks.
--
-- Additive and reversible. `goat.projects` is personal to the member who created
-- it and scoped to one workspace, matching the chat list it reorganizes.
-- `chat_sessions.project_id` is nullable, so every existing conversation stays
-- where it is (Recents) until someone files it. Deleting a project empties it
-- rather than deleting conversations, hence ON DELETE SET NULL.

CREATE TABLE "goat"."projects" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opencompany_projects_name_check" CHECK (length(btrim("goat"."projects"."name")) BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "goat"."projects" ADD CONSTRAINT "projects_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opencompany_projects_owner_idx" ON "goat"."projects" USING btree ("user_workos_id","workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "goat"."chat_sessions" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "goat"."chat_sessions" ADD CONSTRAINT "chat_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "goat"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opencompany_chat_sessions_project_idx" ON "goat"."chat_sessions" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "goat"."users" ADD COLUMN "sidebar_projects_enabled" boolean DEFAULT false NOT NULL;
