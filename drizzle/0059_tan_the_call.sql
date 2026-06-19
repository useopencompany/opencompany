DROP INDEX "workspace_mcp_credentials_server_kind_idx";--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ADD COLUMN "account_key" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ADD COLUMN "external_account_id" text;--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ADD COLUMN "account_label" text;--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ADD COLUMN "account_email" text;--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ADD COLUMN "connected_by_user_id" text;--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ADD CONSTRAINT "workspace_mcp_credentials_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_mcp_credentials_server_kind_account_idx" ON "workspace_mcp_credentials" USING btree ("server_id","kind","account_key");--> statement-breakpoint
CREATE INDEX "workspace_mcp_credentials_server_external_account_idx" ON "workspace_mcp_credentials" USING btree ("server_id","external_account_id");