# opencompany Brain — HubSpot app

Declarative definition of the HubSpot app behind the opencompany Brain HubSpot source
(HubSpot developer-projects framework, platform 2026.03). Deployed to the
`louis [standard]` HubSpot account (148909358) as project
`goat-brain-hubspot-public`, App ID 45903920.

Distribution is `marketplace`, which makes the app a public OAuth app: any
HubSpot portal can install it through the OAuth authorize URL our
`/api/integrations/hubspot/start` route builds — no App Marketplace listing or
review is involved (a listing is a separate, optional submission for
discoverability inside HubSpot).

- `src/app/app-hsmeta.json` — OAuth app: read-only CRM scopes, redirect URLs
  for prod (`my.opencompany.chat`) and local dev.
- `src/app/webhooks/webhooks-hsmeta.json` — webhook target
  `/api/webhooks/hubspot/events` plus the per-property subscription list
  (HubSpot propertyChange subscriptions are per-property; this list is the
  substantive-fields allowlist and the first noise filter).

Deploy changes with the HubSpot CLI (`hs auth` once, then from this directory):

```sh
hs project upload
```

This changes an external provider project. The integrations maintainer owns review; confirm the
selected HubSpot account and project with a read-only CLI command before upload, and do not deploy
from an unreviewed branch.

The OAuth client id/secret live in the app's Auth tab (not exported here);
they map to `OPENCOMPANY_HUBSPOT_CLIENT_ID` / `OPENCOMPANY_HUBSPOT_CLIENT_SECRET` in both the
web and runner environments. `OPENCOMPANY_HUBSPOT_STATE_SECRET` is generated, not from
HubSpot.
