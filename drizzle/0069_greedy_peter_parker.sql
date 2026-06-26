CREATE SCHEMA "connector";
--> statement-breakpoint
CREATE TABLE "connector"."mcp_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
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
CREATE TABLE "connector"."mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"server_key" text NOT NULL,
	"display_name" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"status" text DEFAULT 'missing_credential' NOT NULL,
	"status_reason" text,
	"connected_by_user_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_mcp_servers_status_check" CHECK ("connector"."mcp_servers"."status" IN ('configured', 'missing_credential', 'disabled', 'error'))
);
--> statement-breakpoint
CREATE TABLE "connector"."organization_memberships" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_organization_memberships_role_check" CHECK ("connector"."organization_memberships"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "connector"."organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector"."permission_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"scope" text NOT NULL,
	"granted" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_permission_grants_scope_check" CHECK ("connector"."permission_grants"."scope" IN ('linear.issues.read', 'linear.issues.write'))
);
--> statement-breakpoint
CREATE TABLE "connector"."users" (
	"id" text PRIMARY KEY NOT NULL,
	"workos_user_id" text NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector"."waitlist_signups" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector"."mcp_credentials" ADD CONSTRAINT "mcp_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "connector"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector"."mcp_credentials" ADD CONSTRAINT "connector_mcp_credentials_server_org_fk" FOREIGN KEY ("server_id","organization_id") REFERENCES "connector"."mcp_servers"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector"."mcp_servers" ADD CONSTRAINT "mcp_servers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "connector"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector"."mcp_servers" ADD CONSTRAINT "mcp_servers_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "connector"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector"."organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "connector"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector"."organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "connector"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector"."organizations" ADD CONSTRAINT "organizations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "connector"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector"."permission_grants" ADD CONSTRAINT "permission_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "connector"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_mcp_credentials_org_idx" ON "connector"."mcp_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "connector_mcp_credentials_server_idx" ON "connector"."mcp_credentials" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_mcp_credentials_server_kind_idx" ON "connector"."mcp_credentials" USING btree ("server_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_mcp_servers_org_key_idx" ON "connector"."mcp_servers" USING btree ("organization_id","server_key");--> statement-breakpoint
CREATE INDEX "connector_mcp_servers_org_status_idx" ON "connector"."mcp_servers" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_mcp_servers_id_org_idx" ON "connector"."mcp_servers" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_organization_memberships_org_user_idx" ON "connector"."organization_memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_organizations_slug_idx" ON "connector"."organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_permission_grants_org_provider_scope_idx" ON "connector"."permission_grants" USING btree ("organization_id","provider","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_users_workos_user_id_idx" ON "connector"."users" USING btree ("workos_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_waitlist_signups_email_idx" ON "connector"."waitlist_signups" USING btree ("email");