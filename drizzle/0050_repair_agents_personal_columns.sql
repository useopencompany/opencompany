ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "is_default" boolean;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "is_default" SET DEFAULT false;--> statement-breakpoint
UPDATE "agents" SET "is_default" = false WHERE "is_default" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "is_default" SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.agents'::regclass
      AND conname = 'agents_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "agents"
      ADD CONSTRAINT "agents_user_id_users_id_fk"
      FOREIGN KEY ("user_id")
      REFERENCES "public"."users"("id")
      ON DELETE set null
      ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_workspace_user_default_idx" ON "agents" USING btree ("workspace_id","user_id") WHERE "agents"."is_default" = true;
