CREATE TABLE "session_stars" (
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"starred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_stars" ADD CONSTRAINT "session_stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_stars" ADD CONSTRAINT "session_stars_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_stars_user_session_idx" ON "session_stars" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE INDEX "session_stars_session_idx" ON "session_stars" USING btree ("session_id");