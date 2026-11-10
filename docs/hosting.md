# Hosting

The product API, the runner and Electric are moving from Render to one Hetzner server, deployed
with [Kamal](https://kamal-deploy.org) 2.12.0. Web, marketing and docs stay on Vercel, the database
on Neon and secrets in Infisical. Until the cutover below is done, releases still deploy the API and
runner to Render, and [deployment](deployment.md) describes that flow.

```
kamal-proxy :80/:443
├── api.opencompany.chat, api-next.opencompany.chat → opencompany-api (3001, /healthz), Let's Encrypt
├── runner.opencompany.chat, work.opencompany.space, *.work.opencompany.space
│                                                    → opencompany-runner (3040, /healthz), custom cert
└── kamal network: opencompany-api-electric:3000 (volume opencompany-electric-data:/var/electric)
```

## The server

| | |
| --- | --- |
| Machine | Hetzner Cloud CPX22, `nbg1`, `91.99.204.222` |
| SSH | `main@91.99.204.222`, port 22, key only |
| Docker | from get.docker.com. `main` is in the `docker` group, so Kamal never needs sudo |
| Firewall | Hetzner Cloud Firewall, inbound 22, 80 and 443 only |
| Backups | Hetzner backups on |
| Neon latency | Not measured yet. Record `psql` `\timing` from the server to the direct endpoint here |

Containers run without memory limits. Docker rotates each container's stdout at 50 MB
(`logging.options.max-size`).

### Provisioning

These steps are manual and run once, as root on a fresh server.

1. Create the deploy user and install Docker:

   ```sh
   adduser --disabled-password --gecos "" main
   curl -fsSL https://get.docker.com | sh
   usermod -aG docker main
   ```

2. Harden sshd. In `/etc/ssh/sshd_config.d/50-hardening.conf` set `PermitRootLogin no` and
   `PasswordAuthentication no`, then `systemctl reload ssh`. Keep a root session open until a new
   `ssh main@91.99.204.222` works.
3. Install `fail2ban` and `unattended-upgrades`, and add 4 GB of swap:

   ```sh
   apt-get install -y fail2ban unattended-upgrades
   fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```

4. In the Hetzner console, attach a Cloud Firewall that allows inbound 22, 80 and 443, and turn on
   backups.
5. Generate a key pair for GitHub Actions (`ssh-keygen -t ed25519 -C github-actions -f deploy`).
   Append `deploy.pub` to `~main/.ssh/authorized_keys`. In Infisical `prod` `/release`, store the
   private key as `VM_SSH_PRIVATE_KEY` and the output of `ssh-keyscan 91.99.204.222` as
   `VM_SSH_KNOWN_HOSTS`. Compare the scanned keys with `/etc/ssh/ssh_host_*.pub` on the server
   before saving them, so the workflows never trust a key on first use.
6. From the server, time a query against the Neon direct endpoint (`psql "$URL" -c '\timing'
   -c 'select 1'`) and record the result in the table above.
7. In the GitHub organization settings, let GitHub Actions publish packages. The images are private
   GHCR packages, `ghcr.io/useopencompany/opencompany-api` and `ghcr.io/useopencompany/opencompany-runner`.

## The Kamal configs

Each app has its own Kamal directory. Run Kamal from `apps/api` or `apps/runner`, never from the
repository root.

| | `apps/api` | `apps/runner` |
| --- | --- | --- |
| Service | `opencompany-api` | `opencompany-runner` |
| Hosts | `api.opencompany.chat`, `api-next.opencompany.chat` | `runner.opencompany.chat`, `work.opencompany.space`, `*.work.opencompany.space` |
| TLS | Let's Encrypt, issued by kamal-proxy on the first request | the certificate in Infisical `/runner` |
| Port, health check | 3001, `/healthz` | 3040, `/healthz` |
| Stopping the old container | kamal-proxy drains 60 s, then `docker stop -t 60` | kamal-proxy drains 30 s, then `docker stop -t 300` |
| Accessory | Electric | none |
| Image | `Dockerfile.api` at the repository root | `Dockerfile.runner` at the repository root |

Both apps set `response_timeout: 0`, which turns off kamal-proxy's response-header timeout, and
`buffering.responses: false`, so SSE chat streams and Electric live shapes reach clients chunk by
chunk. Bun and the clients still bound each request.

The runner's `stop_timeout: 300` matches Render's `maxShutdownDelaySeconds`. On SIGTERM the runner
stops claiming work and drains for up to 230 seconds, then hands off what is left
(`apps/runner/src/index.ts`).

### Secrets

`config/deploy.yml` lists the container's keys under `env.secret`. `.kamal/secrets` maps each one
to the job variable of the same name and holds no values. An unset variable ships as an empty
string. The Kamal command workflow loads Infisical `prod` `/release`, then the app's folder, which
wins any key both hold.

Three keys differ from Render:

- `ELECTRIC_URL` is `http://opencompany-api-electric:3000` in the API's `env.clear`. Infisical `/api`
  still syncs the Render Electric URL to the Render API, so the Kamal value cannot live there.
- The Electric accessory needs `/electric`'s `DATABASE_URL`. The workflow exports it as
  `ELECTRIC_DATABASE_URL`, and the accessory aliases it back (`DATABASE_URL:ELECTRIC_DATABASE_URL`).
  The API and the accessory share `ELECTRIC_SECRET`. The workflow fails when `/api` and `/electric`
  hold different values.
- The runner requires `RUNNER_PUBLIC_URL`. Render supplied `RENDER_EXTERNAL_URL`, and the runner
  keeps that fallback until Render is gone.

`scripts/lib/release-preflight.test.mjs` fails when `env.secret`, `.kamal/secrets`, the preflight
group in `scripts/release-preflight.mjs` and the service's keys in `render.yaml` disagree. The
policy job in `verify.yml` runs `kamal config` for both apps with an empty environment whenever a
Kamal file changes.

### Release identity

Kamal sets `KAMAL_VERSION` and `KAMAL_CONTAINER_NAME` in every container. Deploys pass the commit
SHA as the version, so `/healthz` reports it as `release` and the release smoke can match it. Logs
carry `KAMAL_CONTAINER_NAME` as `instance_id`. `deployedRelease()` in
`packages/observability/src/release.ts` is the one place that picks the release.

## Running a Kamal command

`.github/workflows/kamal-command.yml` runs one Kamal command against production with the release's
credentials. Dispatch it from the Actions tab on `main`:

- `app`, `api` or `runner`, the directory the command runs in.
- `command`, starting with `kamal`. The default is `kamal app details`.

Builds through this workflow, such as `kamal build push`, use the runner's plain Docker builder with
no layer cache, so they take a few minutes longer than a release build.

The workflow runs in the `production` environment and has its own concurrency group. Kamal's lock
on the server stops two deploys from overlapping. A cancelled run releases that lock.

| Command | Does |
| --- | --- |
| `kamal app details` | Lists the app's containers |
| `kamal app logs -n 200` | The last 200 stdout lines. Add `--grep <id>` to follow one run |
| `kamal build push` | Builds and pushes an image tagged with the checked-out SHA |
| `kamal deploy --skip-push --version <sha>` | Boots a pushed image. Releases use `kamal deploy`, never `kamal setup` |
| `kamal rollback <sha>` | Boots an older image that the server still holds (Kamal keeps three) |
| `kamal lock status`, `kamal lock release` | Shows or clears a stale deploy lock |
| `kamal proxy logs` | kamal-proxy's log, for TLS or routing problems |
| `kamal accessory logs electric` | Electric's log (`app: api`) |

Never run `kamal setup` on the API once Electric is up. It reboots the accessory, which restarts
Electric's shape log.

Render's log search goes away with Render. Errors still reach Better Stack through
`BETTER_STACK_ERRORS_DSN`. For raw stdout, use `kamal app logs`.

## Electric

Electric is a Kamal accessory of the API: `opencompany-api-electric`, private on Kamal's `kamal`
Docker network, with no published port. It runs the image digest pinned in `render.yaml`, stores
its shape log in the named volume `opencompany-electric-data`, and replicates through its own
stream, `opencompany_hetzner_v1`. The Render Electric keeps `opencompany_render_v1` until PR 3 of
the move drops it.

`kamal deploy` leaves a running accessory alone. To restart it, run `kamal accessory reboot
electric`. That causes a brief read-model interruption, which clients retry.

[Electric read models](electric-sync.md#production-self-hosting) explain why the volume and the
replication stream are one unit. To rebuild Electric:

1. Pick a new stream ID, for example `opencompany_hetzner_v2`, and set it in
   `apps/api/config/deploy.yml`. Merge that change.
2. `kamal accessory remove electric`, then `docker volume rm opencompany-electric-data` on the
   server.
3. `kamal accessory boot electric`. Wait for `/v1/health` to report `active` and for the new slot to
   show bounded lag, then warm the read models.
4. Drop the old publication and slot, following [Electric read models](electric-sync.md). Neon keeps
   WAL for an inactive slot.

## Runner certificate

Let's Encrypt's HTTP challenge cannot issue `*.work.opencompany.space`, so the runner uses one
certificate for all three hosts, issued with a DNS-01 challenge.
`.github/workflows/renew-runner-cert.yml` runs every Monday and on dispatch:

1. It reads the certificate from Infisical `/runner`. With 30 days or less left, or when the stored
   pair is invalid, it issues a new one with lego and the Vercel DNS provider. `VERCEL_DNS_API_TOKEN`
   and `VERCEL_ORG_ID` from `/release` create the TXT records. Both `opencompany.chat` and
   `opencompany.space` are on Vercel DNS.
2. It writes `RUNNER_TLS_PRIVATE_KEY_PEM` and `RUNNER_TLS_CERTIFICATE_PEM` to `/runner`.
3. It reads the certificate `runner.opencompany.chat` serves. kamal-proxy loads the certificate only
   when the runner deploys, so a renewal goes live with the next runner release. Once the served
   certificate has 10 days or less and Infisical holds a newer one, the workflow dispatches
   `release-production.yml` with only the runner (`deploy_api=false`, `redeploy_sites=false`).

The `staging` input issues from Let's Encrypt staging and prints the issuer, hosts and expiry
without storing anything. Use it to prove the DNS challenge works. `force_renewal` renews a current
certificate.

`kamal proxy reboot` also reloads the certificate, but it drops every app on the server for a few
seconds. Prefer a runner release.

The release preflight refuses a stored certificate that is invalid, misses a host, does not match
its key or has 7 days or less left. Until the release deploys with Kamal, it only checks the
certificate when one is stored.

## Moving off Render

The move is three pull requests: prep (Kamal configs, workflows and this document, with releases
still on Render), the release workflow on Kamal (merged right after the cutover) and cleanup a week
later. Traffic is low, and up to 5 minutes of downtime is acceptable.

### Before merging the prep PR

Every release after the merge runs the new preflight, so these values must exist first:

- `/release`: `VM_SSH_PRIVATE_KEY`, `VM_SSH_KNOWN_HOSTS` (provisioning step 5) and
  `VERCEL_DNS_API_TOKEN`, a Vercel token that can edit DNS for both domains.
- `/runner`: `RUNNER_PUBLIC_URL`, set to the runner's current onrender.com URL. The Render runner
  receives it through the sync and resolves the same origin it already uses.

### Staging, days before

None of this affects users.

1. Merge the prep PR. Production behavior does not change.
2. Lower the TTL to 60 seconds on `api.opencompany.chat`, `work.opencompany.space` and
   `*.work.opencompany.space`. Add an A record for `api-next.opencompany.chat` pointing at
   `91.99.204.222`.
3. Dispatch Renew Runner Certificate with `staging`, then without it. Check the stored certificate's
   SANs with `openssl x509 -noout -ext subjectAltName`.
4. Kamal Command, `app: api`: `kamal build push`, then `kamal setup --skip-push`. This installs kamal-proxy and boots Electric on the new stream and the API.
5. Wait for Electric's `/v1/health` to report `active` and for the `opencompany_hetzner_v1` slot to
   be active with bounded lag. Warm every named read model through `api-next`.
6. On `https://api-next.opencompany.chat`, check:
   - `/healthz` reports the staged SHA
   - an authenticated `/v1` call
   - a live chat SSE stream that lasts more than 2 minutes
   - Electric live updates
   - an attachment upload
7. Kamal Command, `app: runner`: `kamal build push`, so the runner image is ready. Do not boot it. The runner is not staged, because two runners would both claim jobs.

Merge nothing to `main` from the start of the cutover until the release-workflow PR lands.

### Cutover window

1. T0:
   - Set `RUNNER_PUBLIC_URL=https://runner.opencompany.chat` in `/runner`, `/api`, `/web` and
     `/release`. The Render API receives it through the sync too, which is harmless.
   - Suspend the Render runner. It stops claiming jobs and drains for up to 300 seconds.
2. T0: dispatch Release Production with `deploy_api` and `deploy_runner` off, so web picks up the
   new URL while the runner drains.
3. T0, in Vercel DNS:
   - add an A record for `runner.opencompany.chat`
   - replace the `work.opencompany.space` and `*.work.opencompany.space` CNAMEs
     (`opencompany-runner-frankfurt.onrender.com`) with A records
   - replace `api.opencompany.chat` with an A record

   All point at `91.99.204.222`.
4. T0, Kamal Command, `app: api`: `kamal deploy --skip-push --version <staged sha>`, so the API
   picks up the new `RUNNER_PUBLIC_URL`.
5. Once the Render runner has exited (300 seconds at most), Kamal Command, `app: runner`:
   `kamal setup --skip-push --version <sha>`. This is the runner's first boot, with workers on.
6. Smoke:
   - both `/healthz` endpoints report the expected release
   - a chat turn completes on the Hetzner runner (`instance_id` in the logs)
   - a preview opens on `*.work.opencompany.space`
   - dictation works once the web release lands
   - the Better Stack probe in [observability](observability.md) passes
7. After the TTL plus 10 minutes with no Render traffic, suspend the Render API and the Render
   Electric. Do not delete them.
8. Merge the release-workflow PR, then dispatch a full release (API, runner and web). Both `/healthz`
   endpoints must match `KAMAL_VERSION`, and the `production-api` and `production-runner`
   deployments must be `success`.

Expected impact:

- Jobs pause from T0 until step 5: the Render drain plus a boot, about 5 to 6 minutes at worst and
  less when idle.
- Web dictation and web-to-runner task calls fail from T0 until the web release lands. That release
  can run past 5 minutes if verification is slow.
- Clients with cached DNS reach the Render API for up to 60 seconds.

Add Better Stack uptime monitors on both `/healthz` endpoints. They replace Render's restart on a
failed health check.

### Rollback

Until the cleanup PR:

1. Resume the Render runner, API and Electric.
2. Restore the onrender.com URL in `RUNNER_PUBLIC_URL` in all four folders.
3. Point DNS back at the Render CNAMEs.
4. Kamal Command, `app: runner`: `kamal app stop`.
5. Dispatch a web-only release.

The Render API still reads from the Render Electric, which never changed.

After the cleanup PR, roll back with Kamal Command: `kamal rollback <sha>`. Migrations only add
columns, so an older image runs on the newer schema.

### Cleanup, a week later

- Drop the `opencompany_render_v1` publication and slot, following
  [Electric read models](electric-sync.md).
- Delete the Render services and turn off the Infisical to Render syncs.
- Delete `RENDER_API_KEY`, `RENDER_SERVICE_ID` and `RENDER_API_SERVICE_ID` from `/release`, and the
  stale `ELECTRIC_URL` from `/api`.
- Delete `render.yaml`, the Render release scripts, the `RENDER_*` fallbacks, the `render_*` log
  fields and `api-next.opencompany.chat`.
- Keep the product's Render plugin. It is a feature, not hosting.

## Known costs and risks

- kamal-proxy loads the runner certificate once per deploy and never reloads it on its own.
  Renewal relies on runner releases, with the workflow's dispatch as the fallback.
- Kamal uploads the runner's private key to the server with mode `0644`. Only `main` and root can
  log in.
- `response_timeout: 0` means a backend that never sends headers holds the connection until the
  client gives up.
- One server is a single point of failure. Hetzner backups and Render, until the cleanup PR, are the
  way back.
