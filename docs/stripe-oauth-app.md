# Goat Stripe App OAuth setup

Goat's customer-facing Stripe integration uses a public Stripe App with OAuth. It does not accept
customer API keys. This app is separate from OpenCompany's own Stripe billing configuration and
must not reuse `GOAT_STRIPE_API_KEY`.

## Create the app

Create the Stripe App from the Stripe account that will own the Marketplace listing:

```bash
stripe login
stripe apps create goat-by-opencompany
```

Use an activated, non-Connect Stripe account for a public app. In the generated
`stripe-app.json`, keep the generated app id and icon path, then configure:

```json
{
  "id": "<generated-app-id>",
  "version": "0.0.1",
  "name": "Goat by OpenCompany",
  "icon": "./<300px-square-icon>.png",
  "sandbox_install_compatible": true,
  "distribution_type": "public",
  "stripe_api_access_type": "oauth",
  "allowed_redirect_uris": [
    "https://<goat-production-domain>/api/integrations/stripe/callback"
  ],
  "permissions": [
    {
      "permission": "connected_account_read",
      "purpose": "Show which Stripe account is connected to the workspace."
    },
    {
      "permission": "balance_read",
      "purpose": "Answer read-only questions about balances and payment activity."
    },
    {
      "permission": "subscription_read",
      "purpose": "Answer read-only questions about subscription health and recurring value."
    },
    {
      "permission": "invoice_read",
      "purpose": "Answer read-only questions about open receivables and collection failures."
    },
    {
      "permission": "event_read",
      "purpose": "Remove stored access when the Stripe App is uninstalled."
    }
  ]
}
```

The production manifest must contain the exact HTTPS callback and no localhost or placeholder
redirects. Upload the app with `stripe apps upload`. Use Stripe's External test release while
testing with invited accounts, then submit the production app and Marketplace listing for review.

## Configure OAuth

Stripe provides separate OAuth install links for live, test, and managed-sandbox modes. Store the
client id from the link Goat will use as `GOAT_STRIPE_OAUTH_CLIENT_ID`, and store the matching app
developer API key as `GOAT_STRIPE_OAUTH_SECRET_KEY`:

- live install link → app-developer live-mode API key
- external test link → app-developer test-mode API key
- sandbox install link → managed-sandbox API key

Do not mix a link and key from different modes. Goat exchanges one-time authorization codes at
Stripe's `/v1/oauth/token` endpoint, encrypts the returned access and refresh tokens, refreshes the
one-hour access token automatically, and atomically stores Stripe's rotated refresh token.

Set `GOAT_STRIPE_OAUTH_STATE_SECRET` to a dedicated random value of at least 32 characters. The
optional `GOAT_STRIPE_OAUTH_CALLBACK_URL` is only for an exact registered callback override; it
defaults to `${GOAT_NEXT_PUBLIC_APP_URL}/api/integrations/stripe/callback`.

## Register the lifecycle webhook

In Stripe's webhook settings, add:

```text
https://<goat-production-domain>/api/webhooks/stripe-app
```

Choose **Listen to events on Connected accounts** and subscribe to:

- `account.application.authorized`
- `account.application.deauthorized`

Store that endpoint's signing secret as `GOAT_STRIPE_APP_WEBHOOK_SECRET`. Goat verifies every
delivery and deletes the matching workspace connection when Stripe sends the deauthorization event.

## Deploy and verify

Put all five required values in the Goat Vercel production environment and Infisical:

- `GOAT_STRIPE_OAUTH_CLIENT_ID`
- `GOAT_STRIPE_OAUTH_SECRET_KEY`
- `GOAT_STRIPE_OAUTH_STATE_SECRET`
- `GOAT_STRIPE_APP_WEBHOOK_SECRET`
- `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`

Keep `GOAT_STRIPE_OAUTH_CALLBACK_URL` unset unless the registered callback differs from the canonical
Goat URL. The release preflight and production workflow fail closed when required OAuth values are
missing. Production values belong in Infisical `prod` + `/goat`. For local external-test work, the
test-mode values can be stored in Infisical `dev` + `/web`; `bun run env:pull` copies them when
present without making Stripe App setup mandatory for every developer.

Verify both a successful install and an uninstall:

1. As a Goat workspace admin, connect a Stripe test account from **Settings → Integrations → Stripe**.
2. Confirm Stripe questions work in main chat.
3. Uninstall **Goat by OpenCompany** from Stripe's Installed apps settings.
4. Refresh Goat and confirm the workspace no longer reports Stripe as connected.
