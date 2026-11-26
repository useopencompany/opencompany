# Hosting

The product API, the runner and Electric run on one Hetzner server, deployed with
[Kamal](https://kamal-deploy.org) 2.12.0. Web, marketing and docs stay on Vercel, the database on
Neon and secrets in Infisical.

```
kamal-proxy :80/:443
├── api.opencompany.chat                            → opencompany-api (3001, /healthz), Let's Encrypt
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
| Swap | 4 GB, `/swapfile` |
| Neon latency | About 6 ms for `select 1` to the direct endpoint in `eu-central-1`, measured 2026-11-17 |

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
| Hosts | `api.opencompany.chat` | `runner.opencompany.chat`, `work.opencompany.space`, `*.work.opencompany.space` |
| TLS | Let's Encrypt, issued by kamal-proxy on the first request | the certificate in Infisical `/runner` |
| Port, health check | 3001, `/healthz` | 3040, `/healthz` |
| Stopping the old container | kamal-proxy drains 60 s, then `docker stop -t 60` | kamal-proxy drains 30 s, then `docker stop -t 300` |
| Accessory | Electric | none |
| Image | `apps/api/Dockerfile`, built from the repository root | `apps/runner/Dockerfile`, built from the repository root |

Both apps set `response_timeout: 0`, which turns off kamal-proxy's response-header timeout, and
`buffering.responses: false`, so SSE chat streams and Electric live shapes reach clients chunk by
chunk. Bun and the clients still bound each request.

The runner has `stop_timeout: 300`. On SIGTERM it stops claiming work and drains for up to 230
seconds, then hands off what is left (`apps/runner/src/index.ts`).

### Secrets

`config/deploy.yml` lists the container's keys under `env.secret`. `.kamal/secrets` maps each one
to the job variable of the same name and holds no values. An unset variable ships as an empty
string. The Kamal command workflow loads Infisical `prod` `/release`, then the app's folder, which
wins any key both hold. A release gives each `kamal deploy` only its app's folder; see
[releases](#releases).

Two keys need care:

- `ELECTRIC_URL` is `http://opencompany-api-electric:3000` in the API's `env.clear`. It is the
  accessory's address on the `kamal` network, which is deploy config rather than a secret, so it
  lives beside the accessory definition instead of in Infisical.
- The Electric accessory needs `/electric`'s `DATABASE_URL`. The workflow exports it as
  `ELECTRIC_DATABASE_URL`, and the accessory aliases it back (`DATABASE_URL:ELECTRIC_DATABASE_URL`).
  The API and the accessory share `ELECTRIC_SECRET`. The workflow fails when `/api` and `/electric`
  hold different values.

`scripts/lib/release-preflight.test.mjs` fails when `env.secret`, `.kamal/secrets` and the preflight
group in `scripts/release-preflight.mjs` disagree. The policy job in `verify.yml` runs `kamal config`
for both apps with an empty environment whenever a Kamal file changes.

### Release identity

Kamal sets `KAMAL_VERSION` and `KAMAL_CONTAINER_NAME` in every container. Deploys pass the commit
SHA as the version, so `/healthz` reports it as `release` and the release smoke can match it. Logs
carry `KAMAL_CONTAINER_NAME` as `instance_id`. `deployedRelease()` in
`packages/observability/src/release.ts` is the one place that picks the release.

## Releases

`.github/workflows/release-production.yml` deploys the API and runner whenever the release plan
selects them:

1. The `build-images` job runs `kamal build push` from `apps/api` and `apps/runner` with
   `VERSION` set to the release SHA, on Blacksmith's cached Docker builder. It pushes to GHCR with
   the job's `GITHUB_TOKEN`. The release job does not start if a build fails, so a broken image
   never follows a migration.
2. Before migrations, the release job exports `/api` and `/runner` to separate files with the
   Infisical action's file export, installs Kamal, and loads the deploy key into
   ssh-agent. The job env cannot feed Kamal: `/api` and `/runner` share key names there, and
   `DATABASE_URL` holds the migration URL.
3. After migrations, `scripts/release-kamal-services.mjs` runs
   `kamal deploy --skip-push --version <sha>` for both apps in parallel. Each process gets its own
   folder's values plus `PATH`, `HOME`, the ssh-agent socket and the GHCR login. The runner also gets
   the release-owned Vercel access-token triple used by its browser sandboxes.
   `/electric` stays out, because a deploy never boots the accessory. Each app's release smoke then
   requires `/healthz` to report the SHA.
4. A cancelled release runs `kamal lock release` for the apps it selected. Removing a lock nobody
   holds is a no-op.

A release never runs `kamal setup`, so Electric keeps running. The runner deploy takes longest: the
old container gets up to 300 seconds to drain after the new one passes its health check.

## Running a Kamal command

`.github/workflows/kamal-command.yml` runs one Kamal command against production with the release's
credentials. Dispatch it from the Actions tab on `main`:

- `app`, `api` or `runner`, the directory the command runs in.
- `command`, starting with `kamal`. The default is `kamal app details`.
- `setup_docker_cache`, for commands that build an image such as `kamal build push`.

The workflow runs in the `production` environment and has its own concurrency group. Kamal's lock
on the server stops two deploys from overlapping. A cancelled run releases that lock.

| Command | Does |
| --- | --- |
| `kamal app details` | Lists the app's containers |
| `kamal app logs -n 200` | The last 200 stdout lines. Add `--grep <id>` to follow one run |
| `kamal build push` | Builds and pushes an image tagged with the checked-out SHA, which the workflow passes as `VERSION` |
| `kamal deploy --skip-push --version <sha>` | Boots a pushed image. Releases use `kamal deploy`, never `kamal setup` |
| `kamal rollback <sha>` | Boots an older image that the server still holds (Kamal keeps three) |
| `kamal lock status`, `kamal lock release` | Shows or clears a stale deploy lock |
| `kamal proxy logs` | kamal-proxy's log, for TLS or routing problems |
| `kamal accessory logs electric` | Electric's log (`app: api`) |

Never run `kamal setup` on the API once Electric is up. It reboots the accessory, which restarts
Electric's shape log.

Errors reach Better Stack through `BETTER_STACK_ERRORS_DSN`. For raw stdout, use `kamal app logs`.

Better Stack uptime monitors cover the public web (`/api/healthz`), API (`/healthz`), and runner
(`/healthz`) endpoints. Keep each monitor's URL aligned with the canonical hosts in the deployment
configuration. When a host moves, update the monitor before retiring the old service, then confirm
the new endpoint returns the deployed release from every configured region.

## Electric

Electric is a Kamal accessory of the API: `opencompany-api-electric`, private on Kamal's `kamal`
Docker network, with no published port. It runs an image pinned by digest in
`apps/api/config/deploy.yml`, stores its shape log in the named volume `opencompany-electric-data`,
and replicates through the stream `opencompany_hetzner_v1`.

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

The release preflight refuses a runner release without a certificate, or with one that is invalid,
misses a host, does not match its key or has 7 days or less left.

## Rollback

Kamal Command: `kamal rollback <sha>` boots an older image that the server still holds. Routine
migrations are additive, so an older image runs on the newer schema; check
[deployment](deployment.md) for the destructive exceptions before rolling back past one.

## Known costs and risks

- kamal-proxy loads the runner certificate once per deploy and never reloads it on its own.
  Renewal relies on runner releases, with the workflow's dispatch as the fallback.
- Kamal uploads the runner's private key to the server with mode `0644`. Only `main` and root can
  log in.
- `response_timeout: 0` means a backend that never sends headers holds the connection until the
  client gives up.
- One server is a single point of failure. Hetzner backups are the way back.
- Docker restarts a container that exits, not one that is up and failing `/healthz`. Better Stack
  detects unhealthy public endpoints, but recovery still requires an operator or a release.
