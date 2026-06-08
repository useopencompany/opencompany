CREATE TABLE "agent_session_message_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"media_type" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob_pathname" text NOT NULL,
	"blob_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_message_attachments_kind_check" CHECK ("agent_session_message_attachments"."kind" IN ('image', 'pdf'))
);
--> statement-breakpoint
ALTER TABLE "agent_session_message_attachments" ADD CONSTRAINT "agent_session_message_attachments_message_id_agent_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agent_session_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_message_attachments" ADD CONSTRAINT "agent_session_message_attachments_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_message_attachments" ADD CONSTRAINT "agent_session_message_attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_message_attachments_message_idx" ON "agent_session_message_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "agent_session_message_attachments_session_idx" ON "agent_session_message_attachments" USING btree ("session_id");