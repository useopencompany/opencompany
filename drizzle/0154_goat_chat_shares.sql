CREATE TABLE "goat"."chat_session_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."chat_session_shares" ADD CONSTRAINT "goat_chat_session_shares_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "goat_chat_session_shares_chat_session_idx" ON "goat"."chat_session_shares" USING btree ("chat_session_id");
