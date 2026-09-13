// Jamie's default header for API-key webhook authentication. The user can rename it when creating
// the webhook; the setup instructions ask them to keep the default so one fixed opencompany
// endpoint serves every connection. Kept free of db/auth imports so the ingress route, the setup
// UI, and their tests stay light.
export const JAMIE_WEBHOOK_API_KEY_HEADER = "x-jamie-api-key";
