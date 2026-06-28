CREATE TABLE "workspace_kpi_values" (
	"id" text PRIMARY KEY NOT NULL,
	"kpi_id" text NOT NULL,
	"point_at" timestamp with time zone NOT NULL,
	"value" numeric NOT NULL,
	"grain" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "workspace_kpi_values_grain_check" CHECK ("workspace_kpi_values"."grain" IN ('day', 'week'))
);
--> statement-breakpoint
CREATE TABLE "workspace_kpis" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_integration_id" text NOT NULL,
	"provider" text NOT NULL,
	"template_id" text NOT NULL,
	"display_name" text NOT NULL,
	"time_grain" text NOT NULL,
	"filter_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_kpis_time_grain_check" CHECK ("workspace_kpis"."time_grain" IN ('day', 'week')),
	CONSTRAINT "workspace_kpis_status_check" CHECK ("workspace_kpis"."status" IN ('active', 'fetch_failed', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD COLUMN "provider_kind" text DEFAULT 'agent_action' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_kpi_values" ADD CONSTRAINT "workspace_kpi_values_kpi_id_workspace_kpis_id_fk" FOREIGN KEY ("kpi_id") REFERENCES "public"."workspace_kpis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_kpis" ADD CONSTRAINT "workspace_kpis_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_kpis" ADD CONSTRAINT "workspace_kpis_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_kpis" ADD CONSTRAINT "workspace_kpis_source_integration_workspace_provider_fk" FOREIGN KEY ("source_integration_id","workspace_id","provider") REFERENCES "public"."workspace_integrations"("id","workspace_id","provider") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_kpi_values_kpi_point_grain_idx" ON "workspace_kpi_values" USING btree ("kpi_id","point_at","grain");--> statement-breakpoint
CREATE INDEX "workspace_kpi_values_kpi_fetched_idx" ON "workspace_kpi_values" USING btree ("kpi_id","fetched_at");--> statement-breakpoint
CREATE INDEX "workspace_kpis_workspace_status_idx" ON "workspace_kpis" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "workspace_kpis_source_integration_idx" ON "workspace_kpis" USING btree ("source_integration_id");--> statement-breakpoint
CREATE INDEX "workspace_integrations_workspace_provider_kind_idx" ON "workspace_integrations" USING btree ("workspace_id","provider","provider_kind");--> statement-breakpoint
ALTER TABLE "workspace_integrations" ADD CONSTRAINT "workspace_integrations_provider_kind_check" CHECK ("workspace_integrations"."provider_kind" IN ('agent_action', 'data_source'));