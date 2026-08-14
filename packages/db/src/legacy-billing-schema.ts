// Runtime compatibility surface for billing tables that the opencompany Stripe webhook still writes.
// The complete public-schema model remains migration-only in schema.ts so future Drizzle
// generation preserves existing tables instead of proposing destructive drops.

export type {
  AutoRefillAttempt,
  WorkspaceBillingSettings,
} from "./schema";
export {
  autoRefillAttempts,
  workspaceBillingSettings,
} from "./schema";
