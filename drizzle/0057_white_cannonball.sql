CREATE TABLE "personal_mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"label" text DEFAULT 'MCP token' NOT NULL,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_mcp_tokens" ADD CONSTRAINT "personal_mcp_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_mcp_tokens" ADD CONSTRAINT "personal_mcp_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_mcp_tokens_workspace_user_idx" ON "personal_mcp_tokens" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_mcp_tokens_token_hash_idx" ON "personal_mcp_tokens" USING btree ("token_hash");