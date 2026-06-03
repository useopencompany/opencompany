CREATE TABLE "agent_session_sandbox_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"run_lease_id" text,
	"sandbox_id" text NOT NULL,
	"template" text,
	"vcpu" integer,
	"ram_mib" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"active_ms" integer DEFAULT 0 NOT NULL,
	"cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"raw_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD COLUMN "sandbox_usage_id" integer;--> statement-breakpoint
ALTER TABLE "agent_session_sandbox_usage" ADD CONSTRAINT "agent_session_sandbox_usage_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_sandbox_usage" ADD CONSTRAINT "agent_session_sandbox_usage_message_id_agent_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agent_session_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_sandbox_usage_session_idx" ON "agent_session_sandbox_usage" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_session_sandbox_usage_message_idx" ON "agent_session_sandbox_usage" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "agent_session_sandbox_usage_session_created_at_idx" ON "agent_session_sandbox_usage" USING btree ("session_id","created_at");--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD CONSTRAINT "workspace_credit_ledger_sandbox_usage_id_agent_session_sandbox_usage_id_fk" FOREIGN KEY ("sandbox_usage_id") REFERENCES "public"."agent_session_sandbox_usage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_credit_ledger_sandbox_usage_idx" ON "workspace_credit_ledger" USING btree ("sandbox_usage_id") WHERE "workspace_credit_ledger"."sandbox_usage_id" IS NOT NULL;