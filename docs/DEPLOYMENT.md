# Deployment

OSVIA Business Care is one Node.js process with a SQLite database in `DATA_DIR`. It does not need a separate database server.

## Requirements

- Node.js 22.13 or newer. Node 24 is what the tests were run on.
- About 200 MB of RAM for the portal process.
- A folder for `DATA_DIR` that is backed up (see `BACKUP.md`).

## Run directly (what this PC uses today)

```bat
npm ci --omit=dev
copy .env.example .env
npm start
```

Open the address in `APP_URL` (default http://127.0.0.1:3080). The first visit asks for the administrator account. There is no default password. Set `SETUP_TOKEN` in `.env` before the first start if anyone else can reach the address, and remove it afterwards.

The administrator and every technician must turn on two-factor authentication before they can use staff tools (`REQUIRE_STAFF_MFA=true`).

## Going public

Put the portal behind a reverse proxy that terminates HTTPS. Then set:

```ini
NODE_ENV=production
APP_URL=https://care.osviatech.com
COOKIE_SECURE=true
TRUST_PROXY=true
BACKUP_KEY=<long random value kept in a password manager>
```

With `NODE_ENV=production` the portal refuses to start if `COOKIE_SECURE` is not `true`, `APP_URL` is not `https://`, or staff two-factor is turned off.

Only set `TRUST_PROXY=true` when the proxy is the only thing that can reach the portal port. Otherwise clients can fake their IP address in rate limits and the audit log.

Keep `HOST=127.0.0.1` when the proxy runs on the same machine. Do not change the existing reverse proxy for other OSVIA services (Ontike, Uptime Kuma). Add a new site block for this host name only.

## Docker Compose

Docker was **not available on the development PC, so these files have not been built or run yet**. Test them on the server before relying on them.

```bash
cp .env.example .env        # edit it; NODE_ENV=production needs the HTTPS settings above
docker compose up -d --build
docker compose ps           # wait for "healthy"
```

- The portal port is published on `127.0.0.1:3080` only.
- The container runs as the unprivileged `node` user with a read-only root filesystem, all capabilities dropped, a 512 MB memory limit and a health check on `/api/health`.
- Data lives in the `portal-data` volume. Nothing mounts the Docker socket.
- MeshCentral is optional: `docker compose --profile meshcentral up -d`. It is published on `127.0.0.1:8443`. Pin the image to a specific version after you have tested it; `latest` is only a starting point.
- To attach the portal to an existing reverse-proxy network named `webnet` without publishing more ports:

  ```bash
  docker compose -f compose.yaml -f compose.webnet.yaml up -d
  ```

Use a separate Compose project name (already set to `osvia-business-care`) so nothing here touches existing containers or volumes.

## Upgrading

1. `npm run backup` (or let the nightly backup run).
2. Stop the portal, update the files, `npm ci --omit=dev`.
3. Optional dry run on a copy: `npm run migrate:check -- data/osvia.sqlite`.
4. Start the portal. Pending migrations run automatically; a `premigration-v<N>-*.sqlite` copy is written to `data/backups` first.

## Load test

`npm run loadtest` starts a separate portal process on port 3099 with a throwaway database, seeds 300 tickets and 150 devices, and runs 25 concurrent workers for 20 seconds. Settings: `LOADTEST_SECONDS`, `LOADTEST_CONCURRENCY`, `LOADTEST_TICKETS`, `LOADTEST_DEVICES`, `LOADTEST_PORT`.
