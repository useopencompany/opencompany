# ADR 0014: Paid Plugins Through Declared Action Prices

- Status: Accepted
- Date: 2026-09-14
- Extends: [ADR 0005](./0005-agent-skills-and-plugins.md) and
  [ADR 0006](./0006-gateway-plugins-and-integrations.md)

## Context

opencompany already runs metered work: managed capabilities execute reviewed provider endpoints
through Monid and pass the provider's settled cost to workspace credits at zero markup. That model
has two limits. The user-facing unit is a source toggle in workspace settings, not something anyone
installs or evaluates; and the price is whatever the provider charged, so nobody can see what a
lookup will cost before running it, and we cannot sell an outcome.

Lead research is the first thing we want to sell as a product rather than pass through as cost. A
founder shopping for prospecting wants to install a plugin, see what a lead costs, cap the daily
spend, and never learn which data broker sits behind it.

Nothing in Agent Plugins 1.0.0 describes price. Adding one hard-coded price table in our client
would make every future paid package a code change in the product repo, which is exactly the
coupling ADR 0006 removed for permissions.

## Decision

### Price is declared in the package

A new manifest extension, `so.opencompany.pricing`, declares a list price per action:

```json
"so.opencompany.pricing": {
  "currency": "USD",
  "actions": {
    "search_prospects": { "label": "Prospect found", "unit": "per_result", "amountUsdMicros": 80000 }
  }
}
```

`unit` is `per_call` or `per_result`. Amounts are USD micros so no float reaches the ledger. Keys
are bare tool names, matching the `so.opencompany.capabilities` convention.

It is honored only for reviewed, integrity-pinned packages from the trusted allowlist, like
capabilities and events. It is stricter than both in one way: pricing is charged rather than
displayed, so any issue voids the whole table instead of degrading to a partial one. A package that
cannot state its prices unambiguously has none, which leaves its actions unsellable rather than
mispriced. Official packages are pinned by commit and vendored as checked-in artifacts, so a price
change is a reviewed diff in this repo, not a silent upstream edit.

### Managed plugins are the third plugin kind

A managed plugin has no connection and no MCP server. Its tools are managed capability actions that
opencompany runs server-side. The package is the user-facing container — catalog entry, install,
skills, prices — and a binding registry in `packages/agent` maps a declared action name to the
reviewed capability spec that executes it. An action the binding does not know is dropped, so a
priced action can never resolve to nothing.

Prospecting moves behind this plugin. Its capability source stays for the runtime and the run
ledger, but it is no longer a workspace toggle: installing the plugin is the switch. Keeping both
surfaces would sell the same lookups twice at two different prices.

### Billing routes through the existing capability ledger

A paid action is quoted at its list price times the most units the call can bill. The Monid
inspection still runs — it is what proves the reviewed endpoint and input contract have not drifted
— but it no longer sets the quote. Settlement bills the list price times the units the provider
actually returned.

A paid plugin sells results. A run the provider answered with nothing, and a run that failed, are
not charged, even where the provider still billed us for the attempt.

The charged total is split across the ledger's existing columns: the provider column carries real
cost of goods where it fits under the list price, and the remainder is our margin. The provider's
true cost is always preserved whole on the ledger's cost basis, so margin stays reportable.

Each run stores a snapshot of the price it was quoted at. Settlement and background reconciliation
read that snapshot, so a workspace that updates or uninstalls the plugin mid-flight is still billed
what it was quoted.

### Spending controls are per plugin and per day

A workspace admin can set a daily ceiling for a paid plugin. A lookup whose maximum quoted cost
would pass the remaining budget is refused rather than offered for approval: approving past a cap
the workspace set would defeat it. The existing per-chat session budget is unchanged and still
governs approval cards.

## Consequences

- A second paid plugin is a package plus a binding registry entry, not a billing change.
- Prices are reviewable as a diff and versioned per installation.
- Selling outcomes rather than passing through cost means margin lives in the fee column and COGS
  lives on the cost basis; usage reporting must read the cost basis to stay truthful.
- Workspaces that used prospecting through the capabilities toggle must install the plugin. The
  actions disappear from the catalog until they do.
- Deferred: per-plugin prepaid balances, usage alerts before the cap is reached, and prices that
  vary by plan.
