CREATE INDEX "goat_message_read_model_v1_conversation_workspace_actor_idx" ON "goat"."message_read_model_v1" USING btree ("conversation_id","workspace_id","actor_id","created_at");--> statement-breakpoint
DROP INDEX "goat"."goat_message_read_model_v1_actor_workspace_conversation_idx";--> statement-breakpoint
CREATE INDEX "goat_run_read_model_v1_conversation_workspace_actor_idx" ON "goat"."run_read_model_v1" USING btree ("conversation_id","workspace_id","actor_id","created_at");--> statement-breakpoint
DROP INDEX "goat"."goat_run_read_model_v1_actor_workspace_conversation_idx";
