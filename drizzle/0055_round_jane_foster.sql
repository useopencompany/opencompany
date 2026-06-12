CREATE TABLE "device_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"device_id" text NOT NULL,
	"session_id" text,
	"tool" text NOT NULL,
	"summary" text NOT NULL,
	"decision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_pairing_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"secret_hash" text NOT NULL,
	"device_name" text NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"device_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_pairing_requests_status_check" CHECK ("device_pairing_requests"."status" IN ('pending', 'confirmed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "workspace_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"secret_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_devices_status_check" CHECK ("workspace_devices"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "agent_tool_approvals" ADD COLUMN "decision_scope" text;--> statement-breakpoint
ALTER TABLE "device_actions" ADD CONSTRAINT "device_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_actions" ADD CONSTRAINT "device_actions_device_id_workspace_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."workspace_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_actions" ADD CONSTRAINT "device_actions_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairing_requests" ADD CONSTRAINT "device_pairing_requests_device_id_workspace_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."workspace_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_devices" ADD CONSTRAINT "workspace_devices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_devices" ADD CONSTRAINT "workspace_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_actions_device_created_idx" ON "device_actions" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE INDEX "device_actions_workspace_created_idx" ON "device_actions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "device_pairing_requests_code_idx" ON "device_pairing_requests" USING btree ("code");--> statement-breakpoint
CREATE INDEX "workspace_devices_workspace_user_idx" ON "workspace_devices" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_devices_secret_hash_idx" ON "workspace_devices" USING btree ("secret_hash");--> statement-breakpoint
ALTER TABLE "agent_tool_approvals" ADD CONSTRAINT "agent_tool_approvals_decision_scope_check" CHECK ("agent_tool_approvals"."decision_scope" IS NULL OR "agent_tool_approvals"."decision_scope" IN ('once', 'session', 'always'));