CREATE TABLE "auto_refill_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"stripe_payment_intent_id" text,
	"amount_usd_micros" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_billing_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"spend_limit_enabled" boolean DEFAULT false NOT NULL,
	"weekly_spend_limit_usd_micros" bigint,
	"auto_refill_enabled" boolean DEFAULT false NOT NULL,
	"auto_refill_threshold_usd_micros" bigint,
	"auto_refill_amount_usd_micros" bigint,
	"stripe_customer_id" text,
	"stripe_default_payment_method_id" text,
	"card_brand" text,
	"card_last4" text,
	"auto_refill_status" text DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auto_refill_attempts" ADD CONSTRAINT "auto_refill_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_refill_attempts" ADD CONSTRAINT "auto_refill_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_billing_settings" ADD CONSTRAINT "workspace_billing_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auto_refill_attempts_payment_intent_idx" ON "auto_refill_attempts" USING btree ("stripe_payment_intent_id") WHERE "auto_refill_attempts"."stripe_payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "auto_refill_attempts_workspace_created_at_idx" ON "auto_refill_attempts" USING btree ("workspace_id","created_at");