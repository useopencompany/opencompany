ALTER TABLE "goat"."integrations" ADD COLUMN "tool_modes" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "integrations_tool_modes_check" CHECK (jsonb_typeof("goat"."integrations"."tool_modes") = 'object');
--> statement-breakpoint
CREATE TABLE "goat"."plugin_gateway_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"server_name" text NOT NULL,
	"connection_provider" text NOT NULL,
	"transport" text NOT NULL,
	"server_url" text NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discovery_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discovered_at" timestamp with time zone,
	"refresh_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_discovery_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_gateway_registrations_server_name_check" CHECK (char_length("goat"."plugin_gateway_registrations"."server_name") BETWEEN 1 AND 200),
	CONSTRAINT "plugin_gateway_registrations_connection_provider_check" CHECK (char_length("goat"."plugin_gateway_registrations"."connection_provider") BETWEEN 1 AND 64),
	CONSTRAINT "plugin_gateway_registrations_transport_check" CHECK ("goat"."plugin_gateway_registrations"."transport" IN ('streamable-http', 'sse')),
	CONSTRAINT "plugin_gateway_registrations_server_url_check" CHECK ("goat"."plugin_gateway_registrations"."server_url" ~ '^https?://'),
	CONSTRAINT "plugin_gateway_registrations_headers_check" CHECK (jsonb_typeof("goat"."plugin_gateway_registrations"."headers") = 'object'),
	CONSTRAINT "plugin_gateway_registrations_capabilities_check" CHECK (jsonb_typeof("goat"."plugin_gateway_registrations"."capabilities") = 'array'),
	CONSTRAINT "plugin_gateway_registrations_discovery_snapshot_check" CHECK (jsonb_typeof("goat"."plugin_gateway_registrations"."discovery_snapshot") = 'array')
);
--> statement-breakpoint
ALTER TABLE "goat"."plugin_gateway_registrations" ADD CONSTRAINT "plugin_gateway_registrations_workspace_plugin_fk" FOREIGN KEY ("workspace_id","plugin_id") REFERENCES "goat"."plugins"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_gateway_registrations_plugin_server_idx" ON "goat"."plugin_gateway_registrations" USING btree ("plugin_id","server_name");
--> statement-breakpoint
CREATE INDEX "plugin_gateway_registrations_workspace_provider_idx" ON "goat"."plugin_gateway_registrations" USING btree ("workspace_id","connection_provider","refresh_after");
