# WhatsApp personal assistant

WhatsApp is a second phone surface for the existing personal-agent runtime. Members enable
its beta in Preferences, then visit Settings → Channels → WhatsApp. They send a 12-digit,
ten-minute code from their WhatsApp account to the shared opencompany business number. Each
member has one binding per channel, with a separate conversation. Existing iMessage bindings,
conversations and API contracts remain intact.

## Provider and initial audience

Use Kapso's managed WhatsApp connection and API proxy. Our runtime owns the assistant;
Kapso handles transport. A thin HTTP client avoids adopting a second agent framework or
building Meta onboarding infrastructure. The sender number is shared, not provisioned per user.

The initial audience is registered EEA phone numbers, including Germany. US, UK and Swiss
numbers are excluded on both ingress and outbound delivery. This is deliberate: the
[Meta AI-provider clause](https://www.whatsapp.com/legal/business-solution-terms?lang=en)
currently permits primary AI assistants for EEA and Brazilian registered numbers, while
prohibiting them elsewhere, including indirect access through providers. Brazil is outside
this initial product scope. A US business sender number does not change recipient eligibility.
Kapso's [personal-agent guide](https://docs.kapso.ai/docs/whatsapp/personal-agent) documents
technical integration, not an exception to Meta's terms. Recheck terms and obtain account
eligibility confirmation before launching; do not advertise US availability without it.

## Runtime behavior

The API verifies Kapso's `X-Webhook-Signature` as hex HMAC-SHA256 over the raw request body.
A number-scoped `kind: meta` webhook forwards the Meta envelope. Status events, other receiving
numbers and BSUID-only messages are ignored; the beta requires the registered phone number.
The webhook has a 256 KiB body limit. Text messages create ordinary durable turns with
server-stamped channel metadata. Images, voice, groups and proactive/template messages are
outside this beta. Unknown senders can only pair; they cannot start agent runs.

Pairing and STOP mutations commit with an ingress receipt. Duplicate webhook delivery cannot
reinterpret a pairing code as a prompt or unlink a later connection. Turn creation uses the
same stable provider-message key for application idempotency. Failed persistence returns 503.
Pair/unlink notices are best effort after commit: a failed notice does not undo the operation.
The settings page remains the source of truth for connection state.

The shared personal-agent runtime keeps its existing search, Wiki, Skills and plugin tools.
Actions needing approval are declined on phone turns; members run them from the app. App-originated
turns never send phone messages. WhatsApp exposes one text reply per turn, capped at 4096
characters, to the verified fixed recipient. Long prose fallback is truncated to that limit;
the complete answer remains in the app. The runner rechecks binding ownership, workspace
membership, the beta flag and the 24-hour reply window immediately before sending.

A durable send claim is written before the network request. Worker replay and fallback use the
same claim, preventing automatic duplicate sends, including when the provider response is lost.
This prioritizes avoiding duplicates: a crash after claiming can leave a reply unsent. Accepted
means provider acceptance, not device delivery; no delivery-receipt UI is implemented. Failed
or ambiguous sends are recorded and surfaced through the tool result in the app, never blindly retried.

## Setup and release

1. Create a Kapso project and connect one business number using
   [Connect WhatsApp](https://docs.kapso.ai/docs/how-to/whatsapp/connect-whatsapp). Complete
   Meta account onboarding and confirm this account can serve the intended AI-assistant audience.
2. Store the project key, numeric phone-number ID, displayed E.164 line handle and webhook secret
   in the [runtime-specific Infisical paths](./env-vars.md#whatsapp-personal-assistant). Sync and
   verify the API and runner hosted environments. Never put provider credentials in browser env.
3. Register a number-scoped Kapso project webhook with `kind: meta`, targeting
   `${OPENCOMPANY_API_ORIGIN}/webhooks/whatsapp/events`. Use its signing secret on the API.
   See [webhook security](https://docs.kapso.ai/docs/platform/webhooks/security) and
   [project webhook creation](https://docs.kapso.ai/api/platform/v1/webhooks/create-project-webhook).
4. Apply migration `0300_whatsapp_personal_agent` through the normal release process. It adds
   the disabled-by-default user flag, bindings, ingress receipts and send-attempt ledger.
   Release preflight fails if the API or runner lacks the provider configuration.
5. Before launch, use an actual German WhatsApp account to pair, receive an assistant answer,
   view that conversation in the app and STOP/unlink. Verify signed redelivery creates no extra
   turn or reply, disabling access blocks sends, and an expired reply window sends nothing.
   Confirm unsupported registered numbers cannot start runs. Local fixture screenshots and
   mocked provider tests do not replace this live check.

As implemented, no live Kapso project configuration was available to the development task.
Provider delivery and hosted configuration have not been validated. Keep the PR in draft until
that verification is complete. The US portion of the original request remains unresolved.

Rollback: disable the beta and webhook before reverting application code. Keep the additive
schema and recorded receipts/attempts to prevent replay; dropping these tables would discard
pairing and delivery history. Existing iMessage conversation data is unaffected.
