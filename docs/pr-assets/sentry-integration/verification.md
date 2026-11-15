# Local Sentry verification, 2026-10-07

The unpublished `opencompany-dev` integration was installed in the EU `opencompany` Sentry
organization and connected to the isolated local Agent Dev workspace. Production was untouched.
The browser and Sentry used the user's Cloudflare Quick Tunnel to port 3002.

The test used an isolated PostgreSQL database. Its temporary infrastructure and local
overrides are excluded from this PR. Normal development setup continues to use branch-isolated
Neon databases through `bun run setup`.

## Live results

| Check | Evidence |
| --- | --- |
| Installation | Global grant exchange, installation identity, EU organization lookup, project selection, and verification succeeded. Sentry reports `installed`. |
| Browser settings | Selected `mobile-app`, cap 2 per UTC day, read tools On, issue updates Ask. |
| Real issue notification | After re-saving the development registration's subscription, Sentry delivered `issue.created` with 202 in 169 ms. Later deliveries took 124 and 140 ms. |
| Task execution | TASK-1 completed from a signed replay of a real Sentry issue. TASK-2 completed from Sentry's own notification. Both investigated through gateway tools and returned findings with issue, occurrence, release, and trace evidence. |
| Task latency | Receipt to committed Task took 2,412 ms for the replay and 2,820 ms for the real notification. |
| Duplicate delivery | Eight concurrent HTTP deliveries through the tunnel returned 202 and produced exactly one durable receipt in PostgreSQL. |
| Ingress validation | Bad signature 401. Invalid signed JSON and resource 400. Warm valid requests took 55 to 164 ms in this session. |
| Admin boundary | Local member could read settings with `canManage=false`; connect, settings, and disconnect returned 403. Admin role restored afterward. |
| Live reads | Projects, users and teams, issue search/details, occurrence list/details, release details/commits, logs, spans, and trace. Empty telemetry and commits returned usable empty results. Unselected project denied. |
| Live writes | Assignment, unassignment, resolution, and permanent archive succeeded on disposable issue MOBILE-APP-4. These direct tool checks do not prove browser approval behavior. |
| Real regression | Resolve and emit the same fingerprint. Sentry sent `issue.unresolved` with `regressed`; after fixing occurrence lookup, routing succeeded and the daily cap suppressed another Task. |
| Manual reopening | Explicit `ongoing` reopening was ignored. A bare API `status=unresolved` sets `regressed` in Sentry and is consequently treated as a regression. |
| Cap | Subsequent real issues and regressions showed `daily cap`, with no new Tasks. |
| Alert configuration | Signed picker request returned one eligible shared workflow. Its destination validated with 200; foreign destination returned 400. |
| Alert delivery | Signed local alert fixtures exercised the configured trigger. The valid destination routed and showed cooldown suppression. A foreign destination was ignored. These were synthetic deliveries, not a real Sentry alert rule. |
| Refresh concurrency | Forced only the local credential to expire. Two separate Bun processes and PostgreSQL pools both succeeded, receiving the same refreshed token in 1,942 and 2,887 ms. |
| Templates | Investigation saved as a draft, then explicitly activated. Daily review saved as a draft with 09:00, Europe/Berlin, and preceding 24-hour instructions. |

The first recreated installation notification arrived while API was restarting and returned
503. That failed delivery is visible in Sentry's request history. Setup itself succeeded
through the browser callback and API grant exchange. Later real issue deliveries succeeded.

## Fixes discovered by the test

- Read installation metadata rather than enumerate organizations with the installation token.
  Sentry returns an empty organization list for this token.
- Preserve installation callback parameters through Google and magic-code authentication,
  validate return paths, and suppress request logging for grant-bearing callback and sign-in URLs.
- Save only project ID and name in template filters. Extra catalog metadata caused strict API
  validation to reject the draft; the existing cleanup archived each failed draft.
- Wait for the existing 30-second refresh lease. The old fast polls gave up before a real
  provider refresh completed.
- Include both start and end in regression occurrence lookup. Sentry rejects end by itself.
  The lookup uses a bounded preceding 90-day window.
- Pass integration credentials through Turbo and allow the configured development hostname
  to load Next's development assets.

## Automated verification

133 focused tests passed: API 15, runner 23, agent 32, web 63. API, runner, agent, and web
typechecks passed. Web lint passed with one existing warning in
`DopplerPluginConnectionForm.tsx`. Formatting and whitespace checks passed for the changed code.

## Remaining checks before release

- A real Sentry alert rule, including external picker and delivery behavior.
- Both coding engines and a draft fix PR. The isolated agent user has no GitHub or coding accounts.
- Live interactive approvals. Background permission behavior is covered by focused tests.
- A US organization, mixed-project trace fixtures, and an actual eight-hour token lifetime.
- More PostgreSQL races around admission, cap rollover, disconnect, and worker recovery.
  The live concurrent checks here establish receipt deduplication and refresh contention only.
- Complete Google or magic-code sign-in from a logged-out installation callback. The live
  redirect preserves parameters; the authentication continuation has automated coverage.

Screenshots in this directory show disconnected and connected settings, investigation
conditions and results, and Task cap usage. The local stack was stopped after verification. The development installation was left
connected with a cap of 2, and daily review remained a draft.
