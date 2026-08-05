-- Workspace-shared Infisical CLI authentication for persistent Codex and Claude Code sandboxes.
-- The credential row keeps a disconnected tombstone so warm sandboxes can reconcile generations.
CREATE TABLE "goat"."infisical_connections" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"encrypted_auth_bundle" jsonb,
	"encryption_key_version" integer,
	"credential_generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"status_reason" text,
	"host" text DEFAULT 'https://app.infisical.com' NOT NULL,
	"account_email" text,
	"cli_version" text,
	"bundle_format_version" integer,
	"expires_at" timestamp with time zone,
	"connected_by_workos_id" text,
	"last_validated_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_infisical_connections_status_check" CHECK ("status" IN ('connected', 'needs_reauth', 'disconnected')),
	CONSTRAINT "goat_infisical_connections_credential_check" CHECK (("status" = 'disconnected' AND "encrypted_auth_bundle" IS NULL AND "encryption_key_version" IS NULL) OR ("status" IN ('connected', 'needs_reauth') AND "encrypted_auth_bundle" IS NOT NULL AND "encryption_key_version" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "goat"."infisical_auth_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"requested_by_workos_id" text,
	"sandbox_id" text NOT NULL,
	"login_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_infisical_auth_flows_status_check" CHECK ("status" IN ('pending', 'link_ready', 'completed', 'failed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "goat"."infisical_connections" ADD CONSTRAINT "goat_infisical_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."infisical_connections" ADD CONSTRAINT "goat_infisical_connections_connected_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("connected_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."infisical_auth_flows" ADD CONSTRAINT "goat_infisical_auth_flows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."infisical_auth_flows" ADD CONSTRAINT "goat_infisical_auth_flows_requested_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("requested_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "goat_infisical_connections_status_idx" ON "goat"."infisical_connections" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "goat_infisical_connections_connected_by_idx" ON "goat"."infisical_connections" USING btree ("connected_by_workos_id");
--> statement-breakpoint
CREATE INDEX "goat_infisical_auth_flows_workspace_status_idx" ON "goat"."infisical_auth_flows" USING btree ("workspace_id", "status");
--> statement-breakpoint
CREATE INDEX "goat_infisical_auth_flows_expires_at_idx" ON "goat"."infisical_auth_flows" USING btree ("expires_at");
