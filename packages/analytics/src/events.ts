// Typed catalog for events still sent to the billing-compatibility PostHog project.
// The shared Stripe webhook and the goat billing/ingestion paths are the only
// remaining emitters; everything else moved to the goat project (goat-events.ts).
export type AnalyticsEventPropertiesByName = {
  // Legacy-product credit fulfillment, still emitted by the shared Stripe webhook
  // when a legacy checkout session completes.
  credit_top_up_completed: {
    user_id: string;
    workspace_id: string;
    checkout_record_id: string;
    ledger_id: number;
    amount_cents: number;
    balance_cents: number;
  };
  goat_billing_topup_started: {
    user_id: string;
    workspace_id: string;
    amount_cents: number;
  };
  goat_billing_topup_completed: {
    workspace_id: string;
    checkout_record_id: string;
    amount_cents: number;
    amount_usd: number;
    balance_cents: number;
  };
  goat_billing_pro_checkout_started: {
    user_id: string;
    workspace_id: string;
    monthly_price_usd_cents: number;
  };
  goat_billing_plan_changed: {
    workspace_id: string;
    plan: "hobby" | "pro";
    subscription_status: string;
  };
  goat_billing_payment_failed: {
    workspace_id: string;
    subscription_id: string;
  };
  goat_billing_auto_refill_succeeded: {
    workspace_id: string;
    amount_cents: number;
  };
  goat_billing_auto_refill_failed: {
    workspace_id: string;
    amount_cents: number;
    reason: string;
  };
  goat_ingestion_paused: {
    workspace_id: string;
    pending_units: number;
  };
  goat_ingestion_backlog_size: {
    workspace_id: string;
    pending_units: number;
  };
};

export type AnalyticsEventName = keyof AnalyticsEventPropertiesByName;

export type AnalyticsEventProperties<EventName extends AnalyticsEventName> =
  AnalyticsEventPropertiesByName[EventName];
