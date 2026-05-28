CREATE TABLE "agent_edit_locks" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_edit_locks" ADD CONSTRAINT "agent_edit_locks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_edit_locks" ADD CONSTRAINT "agent_edit_locks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_edit_locks" ADD CONSTRAINT "agent_edit_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_edit_locks_workspace_idx" ON "agent_edit_locks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_edit_locks_user_idx" ON "agent_edit_locks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_edit_locks_expires_at_idx" ON "agent_edit_locks" USING btree ("expires_at");