ALTER TABLE "goat"."codex_chat_sessions" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions"
	ADD CONSTRAINT "goat_codex_chat_sessions_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id")
	ON DELETE set null ON UPDATE no action;
