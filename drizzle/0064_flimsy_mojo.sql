CREATE TABLE "workspace_codex_credentials" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"encrypted_auth_json" jsonb NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"status_reason" text,
	"connected_by_user_id" text,
	"last_validated_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_codex_credentials_status_check" CHECK ("workspace_codex_credentials"."status" IN ('connected', 'needs_reauth'))
);
--> statement-breakpoint
CREATE TABLE "workspace_codex_device_auth_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"requested_by_user_id" text,
	"sandbox_id" text NOT NULL,
	"user_code" text,
	"verification_uri" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_codex_device_auth_flows_status_check" CHECK ("workspace_codex_device_auth_flows"."status" IN ('pending', 'code_ready', 'completed', 'failed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "codex_reasoning_effort" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "codex_plan_mode_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "codex_plan_mode_reasoning_effort" text DEFAULT 'high' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_codex_credentials" ADD CONSTRAINT "workspace_codex_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_codex_credentials" ADD CONSTRAINT "workspace_codex_credentials_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_codex_device_auth_flows" ADD CONSTRAINT "workspace_codex_device_auth_flows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_codex_device_auth_flows" ADD CONSTRAINT "workspace_codex_device_auth_flows_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_codex_credentials_status_idx" ON "workspace_codex_credentials" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workspace_codex_credentials_connected_by_user_idx" ON "workspace_codex_credentials" USING btree ("connected_by_user_id");--> statement-breakpoint
CREATE INDEX "workspace_codex_device_auth_flows_workspace_status_idx" ON "workspace_codex_device_auth_flows" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "workspace_codex_device_auth_flows_expires_at_idx" ON "workspace_codex_device_auth_flows" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_codex_reasoning_effort_check" CHECK ("agent_sessions"."codex_reasoning_effort" IN ('low', 'medium', 'high', 'xhigh'));--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_codex_plan_mode_reasoning_effort_check" CHECK ("agent_sessions"."codex_plan_mode_reasoning_effort" IN ('low', 'medium', 'high', 'xhigh'));