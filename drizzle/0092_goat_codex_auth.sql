CREATE TABLE IF NOT EXISTS "goat"."codex_credentials" (
	"user_workos_id" text PRIMARY KEY NOT NULL,
	"encrypted_auth_json" jsonb NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"status_reason" text,
	"last_validated_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_codex_credentials_status_check" CHECK ("goat"."codex_credentials"."status" IN ('connected', 'needs_reauth'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."codex_device_auth_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"user_workos_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"user_code" text,
	"verification_uri" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_codex_device_auth_flows_status_check" CHECK ("goat"."codex_device_auth_flows"."status" IN ('pending', 'code_ready', 'completed', 'failed', 'expired'))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'codex_credentials_user_workos_id_users_workos_user_id_fk'
  ) THEN
    ALTER TABLE "goat"."codex_credentials" ADD CONSTRAINT "codex_credentials_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'codex_device_auth_flows_user_workos_id_users_workos_user_id_fk'
  ) THEN
    ALTER TABLE "goat"."codex_device_auth_flows" ADD CONSTRAINT "codex_device_auth_flows_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_codex_credentials_status_idx" ON "goat"."codex_credentials" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_codex_device_auth_flows_user_status_idx" ON "goat"."codex_device_auth_flows" USING btree ("user_workos_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_codex_device_auth_flows_expires_at_idx" ON "goat"."codex_device_auth_flows" USING btree ("expires_at");
