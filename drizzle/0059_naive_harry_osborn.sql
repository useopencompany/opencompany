CREATE TABLE "llm_broker_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_id" text NOT NULL,
	"session_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"model" text,
	"streamed" boolean DEFAULT false NOT NULL,
	"upstream_status" integer,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"input_cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"input_cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"usage_parsed" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"raw_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_broker_requests_non_negative_counters_check" CHECK ("llm_broker_requests"."input_tokens" >= 0 AND "llm_broker_requests"."input_cache_read_tokens" >= 0 AND "llm_broker_requests"."input_cache_write_tokens" >= 0 AND "llm_broker_requests"."output_tokens" >= 0 AND "llm_broker_requests"."cost_usd_micros" >= 0 AND ("llm_broker_requests"."latency_ms" IS NULL OR "llm_broker_requests"."latency_ms" >= 0))
);
--> statement-breakpoint
CREATE TABLE "llm_broker_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"message_id" text,
	"tool_call_id" text,
	"tool_name" text NOT NULL,
	"provider" text NOT NULL,
	"budget_usd_micros" bigint,
	"spent_usd_micros" bigint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"input_cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"input_cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"unparsed_request_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"settled_tool_usage_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "llm_broker_tokens_provider_check" CHECK ("llm_broker_tokens"."provider" IN ('gateway', 'openai')),
	CONSTRAINT "llm_broker_tokens_non_negative_counters_check" CHECK (("llm_broker_tokens"."budget_usd_micros" IS NULL OR "llm_broker_tokens"."budget_usd_micros" >= 0) AND "llm_broker_tokens"."spent_usd_micros" >= 0 AND "llm_broker_tokens"."request_count" >= 0 AND "llm_broker_tokens"."input_tokens" >= 0 AND "llm_broker_tokens"."input_cache_read_tokens" >= 0 AND "llm_broker_tokens"."input_cache_write_tokens" >= 0 AND "llm_broker_tokens"."output_tokens" >= 0 AND "llm_broker_tokens"."unparsed_request_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "llm_broker_requests" ADD CONSTRAINT "llm_broker_requests_token_id_llm_broker_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."llm_broker_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_broker_tokens" ADD CONSTRAINT "llm_broker_tokens_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_broker_tokens" ADD CONSTRAINT "llm_broker_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_broker_tokens" ADD CONSTRAINT "llm_broker_tokens_settled_tool_usage_id_agent_session_tool_usage_id_fk" FOREIGN KEY ("settled_tool_usage_id") REFERENCES "public"."agent_session_tool_usage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_broker_requests_token_idx" ON "llm_broker_requests" USING btree ("token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_broker_tokens_token_hash_idx" ON "llm_broker_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "llm_broker_tokens_session_idx" ON "llm_broker_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "llm_broker_tokens_unsettled_idx" ON "llm_broker_tokens" USING btree ("expires_at") WHERE "llm_broker_tokens"."settled_at" IS NULL;--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1
		FROM "agent_session_tool_usage"
		WHERE "provider_request_id" LIKE 'broker:%'
		GROUP BY "provider_request_id"
		HAVING COUNT(*) > 1
	) THEN
		RAISE EXCEPTION 'duplicate broker provider_request_id values exist in agent_session_tool_usage';
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_tool_usage_broker_request_idx" ON "agent_session_tool_usage" USING btree ("provider_request_id") WHERE "agent_session_tool_usage"."provider_request_id" LIKE 'broker:%';
