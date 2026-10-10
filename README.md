# OSVIA Business Care

Managed IT support portal for OSVIA TECHNOLOGIES, Kampala ([osviatech.com](https://osviatech.com)): helpdesk with SLA, device and asset register, preventive maintenance, service monitoring and incidents, billing in UGX with manual payment verification, reports, and optional MeshCentral remote support with customer consent.

## Technologies

- Node.js 22.13+ (tested on Node 24) with the built-in `node:sqlite` database, no build step
- Plain ES modules in the browser, strict Content-Security-Policy, light and dark themes
- `nodemailer` for SMTP email (the only dependency)
- Optional: MeshCentral through its official `meshctrl.js` tool, Docker Compose

## Quick start (Windows)

```bat
npm ci --omit=dev
copy .env.example .env
npm start
```

Or double-click `start.cmd`. Open http://127.0.0.1:3080. The first visit creates the administrator (no default password) and then asks for two-factor authentication.

## Roles

| Role | Can do |
| --- | --- |
| Administrator (OSVIA) | Everything: organizations, staff, plans, invoices, payment verification, settings, backups |
| Technician (OSVIA) | Tickets assigned to them or unassigned, devices, maintenance, monitoring, incidents, remote support |
| Customer administrator | Their organization's tickets, devices, users, billing, reports and remote-support consent |
| Customer user | Their own tickets and devices assigned to them |

Every rule is enforced by the server, not just hidden in the page.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Run the portal |
| `npm test` | Automated tests (in-memory database, fake SMTP and fake meshctrl) |
| `npm run backup` | Write a backup to `data/backups` |
| `npm run restore -- <file>` | Restore a backup (stop the portal first) |
| `npm run migrate:check -- <db file>` | Migrate a copy of a database and compare row counts |
| `npm run loadtest` | Measure throughput against a throwaway portal on port 3099 |

## Documentation

- [Deployment and Docker](docs/DEPLOYMENT.md)
- [MeshCentral](docs/MESHCENTRAL.md)
- [Backup and restore](docs/BACKUP.md)
- [Security](docs/SECURITY.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Upgrade report](docs/UPGRADE-REPORT.md)

## Not included

- No mobile-money or card API. Payments are recorded as pending and an administrator verifies them against the OSVIA statement.
- MeshCentral has only been tested with a fake `meshctrl`; see `docs/MESHCENTRAL.md` before using it live.
- The Docker files have not been built on this PC.

Never commit `.env` or `data/`.
