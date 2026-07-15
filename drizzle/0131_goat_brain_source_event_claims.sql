-- Cross-member ingest dedup: multiple members can now feed the same brain from
-- overlapping personal integrations (two Gmails on one thread, two Slack
-- connections to one team). Source-item windows carry random ids, so the
-- existing per-item unique indexes can never dedupe across members. Claims
-- record provider-native event identity (Slack team:channel:ts, Gmail RFC822
-- Message-ID, Linear org:issue:delivery) per brain; a flush only enqueues an
-- ingest job for a brain when it claims at least one previously unseen event.
CREATE TABLE "goat"."brain_source_event_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"brain_id" text NOT NULL,
	"source_provider" text NOT NULL,
	"event_key" text NOT NULL,
	"source_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "goat"."brain_source_event_claims" ADD CONSTRAINT "goat_brain_source_event_claims_brain_id_fk" FOREIGN KEY ("brain_id") REFERENCES "goat"."brains"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
-- SET NULL, not cascade: the dedup guarantee must outlive the raw evidence row.
ALTER TABLE "goat"."brain_source_event_claims" ADD CONSTRAINT "goat_brain_source_event_claims_source_item_fk" FOREIGN KEY ("source_item_id") REFERENCES "goat"."brain_source_items"("id") ON DELETE set null;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_brain_source_event_claims_brain_provider_key_idx" ON "goat"."brain_source_event_claims" ("brain_id","source_provider","event_key");--> statement-breakpoint
-- RFC822 Message-ID is the only cross-mailbox identity for an email (Gmail
-- message ids are per-mailbox). Captured by the poll worker from message
-- metadata; NULL for rows buffered before this deploy.
ALTER TABLE "goat"."gmail_message_events" ADD COLUMN "rfc822_message_id" text;
