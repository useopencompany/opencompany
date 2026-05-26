ALTER TABLE "agent_session_amp_artifacts" RENAME TO "agent_session_artifacts";--> statement-breakpoint
ALTER INDEX IF EXISTS "agent_session_amp_artifacts_session_idx" RENAME TO "agent_session_artifacts_session_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "agent_session_amp_artifacts_tool_call_idx" RENAME TO "agent_session_artifacts_tool_call_idx";--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" RENAME CONSTRAINT "agent_session_amp_artifacts_session_id_agent_sessions_id_fk" TO "agent_session_artifacts_session_id_agent_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" RENAME CONSTRAINT "agent_session_amp_artifacts_message_id_agent_session_messages_id_fk" TO "agent_session_artifacts_message_id_agent_session_messages_id_fk";--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" ADD COLUMN "tool_name" text;--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
UPDATE "agent_session_artifacts"
SET
	"tool_name" = 'amp_coder',
	"kind" = 'amp_run',
	"url" = "pull_request_url",
	"external_id" = "amp_thread_id",
	"metadata" = CASE
		WHEN "continued_from_amp_thread_id" IS NULL THEN NULL
		ELSE jsonb_build_object('continuedFromAmpThreadId', "continued_from_amp_thread_id")
	END;--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" ALTER COLUMN "tool_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" ALTER COLUMN "repository_full_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" DROP COLUMN "amp_thread_id";--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" DROP COLUMN "continued_from_amp_thread_id";--> statement-breakpoint
ALTER TABLE "agent_session_artifacts" DROP COLUMN "pull_request_url";
