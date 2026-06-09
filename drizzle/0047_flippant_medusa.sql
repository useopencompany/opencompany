CREATE TABLE "messaging_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"external_id" text,
	"profile_name" text,
	"link_token" text,
	"link_token_expires_at" timestamp with time zone,
	"active_session_id" text,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_channels_status_check" CHECK ("messaging_channels"."status" IN ('disconnected', 'pending_link', 'connected', 'error'))
);
--> statement-breakpoint
CREATE TABLE "messaging_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text,
	"provider" text NOT NULL,
	"direction" text NOT NULL,
	"external_contact_id" text NOT NULL,
	"provider_message_id" text,
	"session_id" text,
	"agent_message_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"preview" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_messages_direction_check" CHECK ("messaging_messages"."direction" IN ('inbound', 'outbound'))
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_source_check";--> statement-breakpoint
ALTER TABLE "messaging_channels" ADD CONSTRAINT "messaging_channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_channels" ADD CONSTRAINT "messaging_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_channels" ADD CONSTRAINT "messaging_channels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_channels" ADD CONSTRAINT "messaging_channels_active_session_id_agent_sessions_id_fk" FOREIGN KEY ("active_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_messages" ADD CONSTRAINT "messaging_messages_channel_id_messaging_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."messaging_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_messages" ADD CONSTRAINT "messaging_messages_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_messages" ADD CONSTRAINT "messaging_messages_agent_message_id_agent_session_messages_id_fk" FOREIGN KEY ("agent_message_id") REFERENCES "public"."agent_session_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_channels_workspace_user_provider_idx" ON "messaging_channels" USING btree ("workspace_id","user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_channels_provider_external_idx" ON "messaging_channels" USING btree ("provider","external_id") WHERE "messaging_channels"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "messaging_channels_link_token_idx" ON "messaging_channels" USING btree ("link_token");--> statement-breakpoint
CREATE INDEX "messaging_channels_active_session_idx" ON "messaging_channels" USING btree ("active_session_id");--> statement-breakpoint
CREATE INDEX "messaging_messages_channel_idx" ON "messaging_messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "messaging_messages_session_idx" ON "messaging_messages" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_messages_provider_message_id_idx" ON "messaging_messages" USING btree ("provider_message_id") WHERE "messaging_messages"."provider_message_id" is not null;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_source_check" CHECK ("agent_sessions"."source" IN ('user', 'agent', 'memory', 'whatsapp'));