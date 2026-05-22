CREATE TABLE "credit_code_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"credit_code_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"max_redemptions" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_checkout_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"stripe_checkout_session_id" text,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_credit_balances" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_credit_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"amount_cents" integer NOT NULL,
	"source" text NOT NULL,
	"stripe_checkout_session_id" text,
	"credit_code_redemption_id" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_credit_code_id_credit_codes_id_fk" FOREIGN KEY ("credit_code_id") REFERENCES "public"."credit_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_checkout_sessions" ADD CONSTRAINT "stripe_checkout_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_checkout_sessions" ADD CONSTRAINT "stripe_checkout_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credit_balances" ADD CONSTRAINT "workspace_credit_balances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD CONSTRAINT "workspace_credit_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD CONSTRAINT "workspace_credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD CONSTRAINT "workspace_credit_ledger_stripe_checkout_session_id_stripe_checkout_sessions_id_fk" FOREIGN KEY ("stripe_checkout_session_id") REFERENCES "public"."stripe_checkout_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD CONSTRAINT "workspace_credit_ledger_credit_code_redemption_id_credit_code_redemptions_id_fk" FOREIGN KEY ("credit_code_redemption_id") REFERENCES "public"."credit_code_redemptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_code_redemptions_code_workspace_idx" ON "credit_code_redemptions" USING btree ("credit_code_id","workspace_id");--> statement-breakpoint
CREATE INDEX "credit_code_redemptions_workspace_idx" ON "credit_code_redemptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_codes_code_idx" ON "credit_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_checkout_sessions_stripe_checkout_session_id_idx" ON "stripe_checkout_sessions" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "stripe_checkout_sessions_workspace_idx" ON "stripe_checkout_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_credit_ledger_workspace_created_at_idx" ON "workspace_credit_ledger" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_credit_ledger_stripe_checkout_session_idx" ON "workspace_credit_ledger" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "workspace_credit_ledger_credit_code_redemption_idx" ON "workspace_credit_ledger" USING btree ("credit_code_redemption_id");