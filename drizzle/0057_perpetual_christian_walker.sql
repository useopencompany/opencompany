CREATE TABLE "kpi_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"metric_id" text NOT NULL,
	"title" text NOT NULL,
	"viz" text NOT NULL,
	"time_range_days" integer DEFAULT 7 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kpi_cards_viz_check" CHECK ("kpi_cards"."viz" IN ('number', 'bar', 'line'))
);
--> statement-breakpoint
CREATE TABLE "kpi_datapoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"metric_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"value" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kpi_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"metric_key" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"metric_type" text NOT NULL,
	"unit" text NOT NULL,
	"label" text NOT NULL,
	"refresh_interval_minutes" integer DEFAULT 15 NOT NULL,
	"next_refresh_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"last_refresh_status" text,
	"last_refresh_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kpi_metrics_metric_type_check" CHECK ("kpi_metrics"."metric_type" IN ('current', 'event', 'bucketed'))
);
--> statement-breakpoint
ALTER TABLE "kpi_cards" ADD CONSTRAINT "kpi_cards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_cards" ADD CONSTRAINT "kpi_cards_metric_id_kpi_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."kpi_metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_cards" ADD CONSTRAINT "kpi_cards_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_datapoints" ADD CONSTRAINT "kpi_datapoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_datapoints" ADD CONSTRAINT "kpi_datapoints_metric_id_kpi_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."kpi_metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_metrics" ADD CONSTRAINT "kpi_metrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kpi_cards_workspace_position_idx" ON "kpi_cards" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "kpi_cards_metric_idx" ON "kpi_cards" USING btree ("metric_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kpi_datapoints_metric_ts_idx" ON "kpi_datapoints" USING btree ("metric_id","ts");--> statement-breakpoint
CREATE INDEX "kpi_datapoints_workspace_idx" ON "kpi_datapoints" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "kpi_metrics_workspace_idx" ON "kpi_metrics" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kpi_metrics_workspace_definition_idx" ON "kpi_metrics" USING btree ("workspace_id","provider","metric_key","config_hash");--> statement-breakpoint
CREATE INDEX "kpi_metrics_next_refresh_at_idx" ON "kpi_metrics" USING btree ("next_refresh_at");