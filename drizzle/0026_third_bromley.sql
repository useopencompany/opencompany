CREATE TABLE "workspace_experiments" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_mcp_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"server_id" text NOT NULL,
	"kind" text NOT NULL,
	"encrypted_payload" jsonb NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"server_key" text NOT NULL,
	"display_name" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"status" text DEFAULT 'missing_credential' NOT NULL,
	"status_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_mcp_servers_status_check" CHECK ("workspace_mcp_servers"."status" IN ('configured', 'missing_credential', 'disabled', 'error'))
);
--> statement-breakpoint
ALTER TABLE "workspace_experiments" ADD CONSTRAINT "workspace_experiments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ADD CONSTRAINT "workspace_mcp_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" ADD CONSTRAINT "workspace_mcp_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_experiments_workspace_key_idx" ON "workspace_experiments" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "workspace_mcp_credentials_workspace_idx" ON "workspace_mcp_credentials" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_mcp_credentials_server_idx" ON "workspace_mcp_credentials" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_mcp_credentials_server_kind_idx" ON "workspace_mcp_credentials" USING btree ("server_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_mcp_servers_workspace_key_idx" ON "workspace_mcp_servers" USING btree ("workspace_id","server_key");--> statement-breakpoint
CREATE INDEX "workspace_mcp_servers_workspace_status_idx" ON "workspace_mcp_servers" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_mcp_servers_id_workspace_idx" ON "workspace_mcp_servers" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "workspace_mcp_credentials" ADD CONSTRAINT "workspace_mcp_credentials_server_workspace_fk" FOREIGN KEY ("server_id","workspace_id") REFERENCES "public"."workspace_mcp_servers"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
