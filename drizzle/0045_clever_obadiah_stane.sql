CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "agent_session_message_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"sub_index" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"message_created_at" timestamp with time zone NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_session_message_chunks" ADD CONSTRAINT "agent_session_message_chunks_message_id_agent_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agent_session_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_message_chunks" ADD CONSTRAINT "agent_session_message_chunks_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_message_chunks" ADD CONSTRAINT "agent_session_message_chunks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_message_chunks" ADD CONSTRAINT "agent_session_message_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_message_chunks_message_sub_idx" ON "agent_session_message_chunks" USING btree ("message_id","sub_index");--> statement-breakpoint
CREATE INDEX "agent_session_message_chunks_scope_idx" ON "agent_session_message_chunks" USING btree ("agent_id","user_id","session_id","message_created_at");--> statement-breakpoint
CREATE INDEX "agent_session_message_chunks_session_order_idx" ON "agent_session_message_chunks" USING btree ("session_id","message_created_at","sub_index");--> statement-breakpoint
CREATE INDEX "agent_session_message_chunks_tsv_idx" ON "agent_session_message_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "agent_session_message_chunks_content_trgm_idx" ON "agent_session_message_chunks" USING gin ("content" gin_trgm_ops);