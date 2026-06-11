ALTER TABLE "agents" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_workspace_user_default_idx" ON "agents" USING btree ("workspace_id","user_id") WHERE "agents"."is_default" = true;