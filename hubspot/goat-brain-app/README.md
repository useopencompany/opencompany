# OpenCompany Goat Brain — HubSpot app

Declarative definition of the HubSpot app behind the Goat Brain HubSpot source
(HubSpot developer-projects framework, platform 2026.03). Deployed to the
`louis [standard]` HubSpot account (148909358) as project `goat-brain-hubspot`,
App ID 45902861.

- `src/app/app-hsmeta.json` — private-distribution OAuth app: read-only CRM
  scopes, redirect URLs for prod (`my.opencompany.chat`) and local dev.
- `src/app/webhooks/webhooks-hsmeta.json` — webhook target
  `/api/webhooks/hubspot/events` plus the per-property subscription list
  (HubSpot propertyChange subscriptions are per-property; this list is the
  substantive-fields allowlist and the first noise filter).

Deploy changes with the HubSpot CLI (`hs auth` once, then from this directory):

```sh
hs project upload
```

The OAuth client id/secret live in the app's Auth tab (not exported here);
they map to `GOAT_HUBSPOT_CLIENT_ID` / `GOAT_HUBSPOT_CLIENT_SECRET` in both the
web and runner environments. `GOAT_HUBSPOT_STATE_SECRET` is generated, not from
HubSpot.

Distribution is `private`, so the app can only be installed into this HubSpot
account's own org. Supporting customer portals later means recreating it as a
`marketplace`-distribution app in a HubSpot developer account (same project
config, different `distribution`), which does not require an actual marketplace
listing.
