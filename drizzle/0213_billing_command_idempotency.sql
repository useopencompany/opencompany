CREATE TABLE "goat"."billing_command_idempotency" (
  "command_id" text PRIMARY KEY NOT NULL,
  "user_workos_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "operation" text NOT NULL,
  "response" jsonb,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "touched_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "goat_billing_command_idempotency_request_hash_check"
    CHECK ("goat"."billing_command_idempotency"."request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "goat_billing_command_idempotency_key_length_check"
    CHECK (length("goat"."billing_command_idempotency"."idempotency_key") BETWEEN 1 AND 200),
  CONSTRAINT "goat_billing_command_idempotency_operation_check"
    CHECK ("goat"."billing_command_idempotency"."operation" IN ('credit_topup.create', 'subscription_checkout.create', 'billing_portal.create', 'auto_refill.update'))
);--> statement-breakpoint
ALTER TABLE "goat"."billing_command_idempotency"
  ADD CONSTRAINT "billing_command_idempotency_user_workos_id_users_workos_user_id_fk"
  FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."billing_command_idempotency"
  ADD CONSTRAINT "billing_command_idempotency_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_billing_command_idempotency_actor_key_idx"
  ON "goat"."billing_command_idempotency" USING btree
  ("user_workos_id", "workspace_id", "idempotency_key");
