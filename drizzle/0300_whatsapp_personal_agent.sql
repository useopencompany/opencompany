-- Additive WhatsApp beta. Existing iMessage bindings and conversations are unchanged.
ALTER TABLE "goat"."users" ADD COLUMN "whatsapp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "goat"."whatsapp_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"link_code" text,
	"link_code_expires_at" timestamp with time zone,
	"handle" text,
	"conversation_id" text,
	"linked_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_bindings_status_check" CHECK ("goat"."whatsapp_bindings"."status" IN ('pending', 'linked'))
);--> statement-breakpoint
ALTER TABLE "goat"."whatsapp_bindings" ADD CONSTRAINT "whatsapp_bindings_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."whatsapp_bindings" ADD CONSTRAINT "whatsapp_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."whatsapp_bindings" ADD CONSTRAINT "whatsapp_bindings_conversation_id_chat_sessions_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_bindings_user_idx" ON "goat"."whatsapp_bindings" USING btree ("user_workos_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_bindings_handle_idx" ON "goat"."whatsapp_bindings" USING btree ("handle") WHERE "goat"."whatsapp_bindings"."handle" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_bindings_link_code_idx" ON "goat"."whatsapp_bindings" USING btree ("link_code") WHERE "goat"."whatsapp_bindings"."link_code" IS NOT NULL;

--> statement-breakpoint
CREATE TABLE "goat"."whatsapp_send_attempts" (
 "id" text PRIMARY KEY NOT NULL,
 "status" text NOT NULL,
 "provider_message_id" text,
 "created_at" timestamptz DEFAULT now() NOT NULL,
 "updated_at" timestamptz DEFAULT now() NOT NULL,
 CONSTRAINT "whatsapp_send_attempts_status_check" CHECK ("status" IN ('pending', 'accepted', 'failed'))
);

--> statement-breakpoint
CREATE TABLE "goat"."whatsapp_ingress_receipts" (
 "id" text PRIMARY KEY NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL
);
