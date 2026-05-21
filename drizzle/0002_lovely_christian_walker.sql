CREATE TABLE "onboarding_responses" (
	"user_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"heard_from" text NOT NULL,
	"heard_from_detail" text,
	"role" text NOT NULL,
	"agent_experience" text NOT NULL,
	"help_areas" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "team_size" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_url" text;--> statement-breakpoint
ALTER TABLE "onboarding_responses" ADD CONSTRAINT "onboarding_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_responses" ADD CONSTRAINT "onboarding_responses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_responses_workspace_idx" ON "onboarding_responses" USING btree ("workspace_id");