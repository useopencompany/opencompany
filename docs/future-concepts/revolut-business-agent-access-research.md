# Revolut Business Agent Access

Status: researched recommendation
Date: 2026-08-04

## User Job

Founders and small teams want opencompany to help with finance admin that is easy to
miss and annoying to do manually:

- "Which Revolut card expenses are missing receipts?"
- "Find the missing invoice or receipt in Gmail or Drive."
- "Export all receipts for last month to my accounting folder."
- "Tell me which supplier bills still need payment or review."

The core job is not "give an agent bank access." It is "make a bounded finance
assistant that can identify gaps, collect evidence, and put files where the user
expects, without moving money or changing bank records by default."

## Short Answer

Yes, we can give opencompany useful Revolut access, but the first useful version should
be a workspace-owned, read-only Revolut Business connector.

The good first feature is:

- read Revolut Business expenses, transactions, balances, and receipts;
- detect expenses in `missing_info` or expenses with empty `receipt_ids`;
- retrieve receipt files that already exist in Revolut;
- reconcile Revolut expenses against Gmail/Drive/Slack/user uploads already
  connected to opencompany;
- export evidence and reports into Google Drive, Brain, or another user-chosen
  destination when the user asks.

The risky or currently unsupported part is uploading missing receipts or bills
back into Revolut through a documented public API. Revolut documents app, web,
email-forwarding, accounting sync, and BillPay upload flows for users, but the
Business API docs I found expose expense and receipt retrieval rather than
receipt or bill upload endpoints.

## API Reality

Revolut has two relevant API families.

### Revolut Business API

This is the right path for OpenCompany's own-business finance assistant.
Revolut says Business API customers can automate business processes including
viewing accounts, managing counterparties, making payments, exchanging currency,
expense management, transactions, and webhooks. Source: [Business API
reference](https://developer.revolut.com/docs/api/business).

Authentication is certificate/JWT based. Each request uses a bearer access
token, access tokens expire after 40 minutes, and setup also returns a refresh
token. Revolut scopes include:

- `READ` for `GET` operations;
- `WRITE` for counterparties, webhooks, and payment drafts;
- `PAY` for initiating/cancelling transactions and currency exchanges;
- `READ_SENSITIVE_CARD_DATA` for sensitive card details, with mandatory IP
  whitelisting.

Source: [Business API reference authentication](https://developer.revolut.com/docs/api/business).

For an OpenCompany MVP, `READ` is enough. We should not request `PAY`. We should
not request `READ_SENSITIVE_CARD_DATA`.

The Business API supports expenses and receipts in the exact direction we need
for discovery and export:

- list expenses, filter by date range, state, and transaction type;
- retrieve a specific expense;
- retrieve receipt content for a known expense and receipt id;
- use `receipt_ids` on expenses to determine whether receipts exist.

Revolut's guide says the expense feature is not available in Sandbox, which
means production validation will need a real Revolut Business account and a
non-destructive read-only test plan. Source: [Retrieve expenses and
receipts](https://developer.revolut.com/docs/guides/manage-accounts/accounts-and-transactions/retrieve-expenses).

Useful expense fields for opencompany:

- `id`
- `state`
- `transaction_type`
- `description`
- `merchant`
- `payer`
- `transaction_id`
- `expense_date`
- `labels`
- `splits`
- `receipt_ids`
- `spent_amount`

The expense guide defines `missing_info` as the initial state while required
information is missing. It also documents filtering by `state`, so opencompany can ask
for `state=missing_info` and then inspect `receipt_ids`. Source: [Retrieve
expenses and receipts](https://developer.revolut.com/docs/guides/manage-accounts/accounts-and-transactions/retrieve-expenses).

The Business API also supports accounts, transaction history, and transaction
webhooks. Revolut's account/transaction guide describes fetching account details,
balances, transaction history, and using webhooks for transaction changes.
Source: [Accounts and transactions syncing](https://developer.revolut.com/docs/guides/manage-accounts/use-cases/accounts-and-transactions-syncing).

Webhooks v2 support `TransactionCreated`, `TransactionStateChanged`,
`PayoutLinkCreated`, and `PayoutLinkStateChanged`; they require HTTPS and return
a signing secret. Source: [Business API webhooks](https://developer.revolut.com/docs/api/business#get-webhooks).

Rate limit: 60 requests per minute per business unless Enterprise support raises
it. Source: [Business API usage and limits](https://developer.revolut.com/docs/guides/manage-accounts/api-usage-and-testing/usage-and-limits).

### Revolut Open Banking API

Open Banking is less attractive for this product job. Revolut describes it as a
gateway for third-party providers to interact with Revolut customers, including
regulated third-party providers that access account/transaction information or
initiate payments. Source: [Open Banking API](https://developer.revolut.com/docs/api/open-banking).

It can read accounts and transactions, but it is not the best first path for
Revolut Business expense receipts because it does not appear to expose the
Business expense and receipt objects that matter for missing-invoice workflows.
It also adds regulated-provider and consent complexity that is not needed for a
workspace-owned Revolut Business connector.

## Upload Reality

There are three separate "upload" jobs that sound similar but are technically
different.

### Upload receipts to an existing Revolut expense

Revolut user help documents several user-facing paths:

- mobile push notification after card spend;
- later upload from mobile;
- upload from the web app;
- forwarding a digital receipt to a unique Revolut receipt email address.

Forwarded receipts are scanned and attached automatically. Supported formats are
PDF, JPG, and PNG with a 6 MB limit. Source: [Receipts for
expenses](https://help.revolut.com/en-DE/help/managing-my-business/expenses/how-do-i-attach-a-receipt-to-an-expense/business/).

I did not find a documented Business API endpoint to upload receipt content to
an expense. The API docs expose retrieve/list expense operations and receipt
content retrieval, not a `POST /expenses/.../receipts` style endpoint.

Product implication: opencompany can identify missing receipts and find candidate files.
It can save them to Drive/Brain or send them to a human. Directly attaching the
receipt back into Revolut should remain out of scope until Revolut documents an
API or we build a clearly user-driven email-forwarding workaround.

### Upload supplier bills/invoices into Revolut BillPay

Revolut BillPay supports user-facing bill upload by drag-and-drop, email
forwarding, and auto-pull from accounting tools. Uploaded bills become draft
transfers that can be reviewed before payment. Source: [Upload bills to
Revolut](https://help.revolut.com/en-AT/business/help/integrating-with-external-apps/introduction-to-billpay/revolut-billpay-settings/upload-bills-to-revolut/).

Revolut's Bills product page says BillPay connects with Xero, NetSuite, and
QuickBooks Online, transfers bills awaiting payment, and syncs paid bill
transactions back to accounting software. Source: [Revolut
Bills](https://www.revolut.com/en-US/business/bills/).

I did not find a documented public Business API endpoint for creating BillPay
bills from files. The Business API does include payment drafts, payouts, and
transfers, but those are money-movement surfaces, not a safe invoice-upload MVP.

Product implication: do not launch "upload bills into Revolut" as an agent
action unless Revolut confirms a supported API or we route through a connected
accounting system with explicit user approval.

### Upload invoices somewhere else

This is viable now. opencompany can already use existing integrations such as Gmail and
Google Drive in the action framework. For v1, "upload them somewhere if needed"
should mean:

- save candidate missing receipts to a chosen Google Drive folder;
- create a month-end folder of Revolut receipt exports;
- save a markdown/CSV report to Drive;
- add source evidence to Brain only when the user explicitly asks.

## Recommended Product Shape

Build a Revolut Business connector that is workspace-owned and read-only by
default, following the existing Stripe pattern in opencompany:

- workspace admin connects it;
- credentials stay encrypted server-side;
- actions are only exposed when the connection is valid;
- results are treated as live operational finance data;
- no automatic Brain-fill surveys;
- no money movement permissions in v1.

### Connection

Settings -> Integrations -> Revolut Business.

Admin setup:

1. Create/upload the Revolut Business API certificate in Revolut.
2. Grant only `READ` scope for v1.
3. Complete the app-confirm consent flow and exchange the authorization code.
4. Store encrypted connection material server-side:
   - client id;
   - private key or signing key reference;
   - refresh token;
   - access token expiry;
   - account/business display label;
   - environment;
   - granted scopes.
5. Optionally ask the admin to IP-whitelist OpenCompany production egress IPs
   once we have stable egress addresses. This should be recommended for banking
   access even when not strictly required for `READ`.

Do not accept raw all-powerful credentials from ordinary workspace members. This
should be admin-managed like Stripe.

### Chat Actions

Expose these read-only actions first:

- `revolut.list_missing_expenses`
  - Inputs: date range, optional transaction type, optional max count.
  - Reads `/expenses` with `state=missing_info`, inspects `receipt_ids`, and
    returns bounded records with merchant, payer, date, amount, currency,
    transaction id, receipt count, and Revolut expense id.

- `revolut.get_expense`
  - Inputs: expense id.
  - Returns one expense with safe fields and related transaction id.

- `revolut.download_expense_receipts`
  - Inputs: expense id, receipt ids.
  - Retrieves receipt content for receipts already present in Revolut and saves
    them as transient artifacts or to a user-requested destination. Do not dump
    binary content into model context.

- `revolut.get_transaction_summary`
  - Inputs: date range, account id optional.
  - Bounded transaction listing and summary for reconciliation.

- `revolut.get_accounts`
  - Returns account labels, currencies, balances, and ids.

Later read-only actions:

- `revolut.export_receipts_for_period`
  - Packages all available receipts and a CSV manifest.

- `revolut.reconcile_missing_receipts`
  - Uses Revolut missing expenses plus Gmail/Drive search to propose candidate
    receipt files. This should be an orchestrated workflow, not one provider API
    call.

### Write Actions

Do not ship write actions in v1.

Potential later actions, all `Ask` by default:

- create or update a webhook registration;
- create a payment draft, never an immediate payment;
- forward a candidate receipt to the user's Revolut receipt email address, if
  the user provides and verifies that address;
- create a bill in an accounting platform that Revolut BillPay can auto-pull.

Never expose direct `PAY` scope to agents without a much more explicit banking
approval model, payment limits, dual-control UX, audit logs, and legal review.

## Agent Experience

Good v1 prompts:

- "Find Revolut expenses missing receipts this month."
- "For these missing Revolut expenses, search Gmail and Drive for matching
  invoices."
- "Put the matching receipts in Drive under Finance/Receipts/2026-07 and give me
  a review list."
- "Export all Revolut receipts for July into a zip and a CSV manifest."

The assistant should answer with status buckets:

- needs receipt;
- has receipt in Revolut;
- likely match found in Gmail/Drive;
- no match found;
- needs human review.

Every match should include why it was matched, for example merchant, amount,
date window, filename, sender, or email subject. Financial matching should label
inference clearly.

## Security And Compliance

Financial data is high-risk operational data. Treat Revolut like Stripe or more
strictly.

Required controls:

- workspace admin only for connect/disconnect/rotate;
- `READ` scope only for v1;
- reject `PAY` and `READ_SENSITIVE_CARD_DATA` in v1;
- encrypted credentials only;
- never expose access tokens, refresh tokens, private keys, webhook signing
  secrets, account numbers, or full card details to the model;
- redact or omit bank account identifiers unless the user explicitly asks and
  the action is designed for it;
- bounded pagination and date ranges;
- 60 request/minute provider budget with backoff;
- audit log every action call with user, workspace, action id, date range,
  result count, destination, and whether files were exported;
- no automatic Brain persistence for live finance data;
- require explicit user intent before saving finance artifacts to Brain or Drive;
- no browser automation against logged-in Revolut pages.

The no-browser-automation rule matters because `apps/app/lib/browser-profiles`
already blocks banking domains, and direct browser access to a bank account is a
bad trust boundary for agents. Use APIs or user-provided files.

## Implementation Direction

Prefer implementing this as a first-party action provider in the goat app and
`@opencompany/core`, matching the existing action catalog pattern.

Suggested code shape:

1. Add `revolut` to `ActionProviderId`.
2. Add encrypted connection storage for a workspace-owned Revolut connection.
3. Add `apps/app/lib/integrations/revolut.ts` for connect, validate, refresh,
   and API request helpers, with server-only credential handling.
4. Add `packages/core/src/actions/revolut.ts` with bounded read-only
   actions.
5. Add the resolver to `packages/core/src/actions/catalog.ts`.
6. Add Settings -> Integrations -> Revolut Business, copying the admin-managed
   mental model from Stripe rather than personal OAuth integrations.
7. Add docs under `apps/app/content/docs/integrations/revolut.mdx`.
8. Add tests for:
   - absent catalog when disconnected;
   - rejected unsupported scopes;
   - token refresh path;
   - missing-expense filtering and pagination;
   - binary receipt handling without model-context leakage;
   - rate-limit/provider errors mapped to structured action errors;
   - no Brain persistence unless explicitly requested.

Open design question: whether OpenCompany has stable production egress IPs for
optional Revolut IP whitelisting. If not, solving that should be part of the
launch plan.

## MVP Recommendation

Ship a "Revolut missing receipts" MVP before anything that uploads into Revolut:

1. Connect Revolut Business with `READ` scope.
2. List missing-info expenses for a date range.
3. Search connected Gmail and Drive for candidate invoices/receipts.
4. Let the user review candidates.
5. Export accepted candidates to a Drive folder with a CSV manifest.
6. Tell the user which items still need manual action in Revolut.

This is small enough for a 2-10 person team, creates immediate value, and avoids
crossing into payment initiation or unsupported Revolut write APIs.

## Non-Goals For V1

- No direct payment initiation.
- No payment cancellation.
- No currency exchange.
- No card sensitive data.
- No browser automation on Revolut.
- No direct receipt or bill upload into Revolut unless Revolut confirms a
  supported API.
- No automatic Brain capture of live Revolut finance data.
- No workspace-wide access from a personal Revolut account.

