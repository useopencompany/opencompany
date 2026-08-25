CREATE TABLE "goat"."chat_session_skill_bundles" (
	"chat_session_id" text NOT NULL,
	"bundle_id" text NOT NULL,
	"activated_message_id" text NOT NULL,
	"source_kind" text NOT NULL,
	CONSTRAINT "goat_chat_session_skill_bundles_chat_session_id_bundle_id_pk" PRIMARY KEY("chat_session_id","bundle_id"),
	CONSTRAINT "chat_session_skill_bundles_source_kind_check" CHECK ("goat"."chat_session_skill_bundles"."source_kind" IN ('standalone', 'plugin'))
);
--> statement-breakpoint
ALTER TABLE "goat"."chat_session_skill_bundles" ADD CONSTRAINT "chat_session_skill_bundles_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."chat_session_skill_bundles" ADD CONSTRAINT "chat_session_skill_bundles_bundle_id_skill_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "goat"."skill_bundles"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."chat_session_skill_bundles" ADD CONSTRAINT "chat_session_skill_bundles_activated_message_id_chat_messages_id_fk" FOREIGN KEY ("activated_message_id") REFERENCES "goat"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "goat_chat_session_skill_bundles_bundle_idx" ON "goat"."chat_session_skill_bundles" USING btree ("bundle_id");
--> statement-breakpoint
CREATE INDEX "goat_chat_session_skill_bundles_activated_message_idx" ON "goat"."chat_session_skill_bundles" USING btree ("activated_message_id");
