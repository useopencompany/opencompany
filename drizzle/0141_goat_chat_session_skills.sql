CREATE TABLE "goat"."chat_session_skills" (
	"chat_session_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"brain_ref" text NOT NULL,
	"activated_message_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"instructions" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_chat_session_skills_chat_session_id_skill_id_pk" PRIMARY KEY("chat_session_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "goat"."chat_session_skills" ADD CONSTRAINT "chat_session_skills_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."chat_session_skills" ADD CONSTRAINT "chat_session_skills_activated_message_id_chat_messages_id_fk" FOREIGN KEY ("activated_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "goat_chat_session_skills_activated_message_idx" ON "goat"."chat_session_skills" USING btree ("activated_message_id");
--> statement-breakpoint
CREATE INDEX "goat_chat_session_skills_brain_idx" ON "goat"."chat_session_skills" USING btree ("brain_ref");
