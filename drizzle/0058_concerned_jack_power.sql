CREATE TABLE "personal_mcp_oauth_authorization_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text DEFAULT 'mcp:read' NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_mcp_oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text DEFAULT 'MCP client' NOT NULL,
	"client_uri" text,
	"logo_uri" text,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_types" jsonb DEFAULT '["authorization_code","refresh_token"]'::jsonb NOT NULL,
	"response_types" jsonb DEFAULT '["code"]'::jsonb NOT NULL,
	"scope" text DEFAULT 'mcp:read' NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_mcp_oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"access_token_hash" text NOT NULL,
	"refresh_token_hash" text,
	"client_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scope" text DEFAULT 'mcp:read' NOT NULL,
	"resource" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_mcp_oauth_authorization_codes" ADD CONSTRAINT "personal_mcp_oauth_authorization_codes_client_id_personal_mcp_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."personal_mcp_oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_mcp_oauth_authorization_codes" ADD CONSTRAINT "personal_mcp_oauth_authorization_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_mcp_oauth_authorization_codes" ADD CONSTRAINT "personal_mcp_oauth_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_mcp_oauth_tokens" ADD CONSTRAINT "personal_mcp_oauth_tokens_client_id_personal_mcp_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."personal_mcp_oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_mcp_oauth_tokens" ADD CONSTRAINT "personal_mcp_oauth_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_mcp_oauth_tokens" ADD CONSTRAINT "personal_mcp_oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_mcp_oauth_codes_client_idx" ON "personal_mcp_oauth_authorization_codes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "personal_mcp_oauth_codes_expires_at_idx" ON "personal_mcp_oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_mcp_oauth_clients_client_id_idx" ON "personal_mcp_oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_mcp_oauth_tokens_access_hash_idx" ON "personal_mcp_oauth_tokens" USING btree ("access_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_mcp_oauth_tokens_refresh_hash_idx" ON "personal_mcp_oauth_tokens" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "personal_mcp_oauth_tokens_client_user_idx" ON "personal_mcp_oauth_tokens" USING btree ("client_id","user_id");