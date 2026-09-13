-- Additive opt-in. Rolling back application code leaves the disabled-by-default preference harmless.
ALTER TABLE "goat"."users" ADD COLUMN "past_session_access_enabled" boolean DEFAULT false NOT NULL;
