# Upgrade report: OSVIA Business Care 1.0.0

Date: 10 October 2026. The upgrade was done in place on the existing portal. Git checkpoint before the work: `3cc20a3 Checkpoint before Business Care upgrade`.

## Starting point (audit)

- Single Node.js process, `node:sqlite`, schema version 2, one 37 KB browser script.
- Working: admin setup, sign-in, organization registration, tickets (basic), device inventory with ping/port checks, plans, manual payments, maintenance PDF, notifications, audit log, `VACUUM INTO` backup.
- Missing or weak: two-factor, CSRF tokens, invitations, SLA, attachments, monitoring and incidents, invoices and receipts, verified payment flow, reports, SMTP, MeshCentral, migrations with backups, responsive UI, tests beyond a few workflows.
- Existing data: 1 organization, 2 users, 1 ticket, 4 devices, 24 audit events. A copy was saved as `data/backups/pre-upgrade-checkpoint.sqlite`.

## Data migration

- Versioned migrations (`server/migrations.js`). The real database went from version 2 to 3. A `premigration-v2-*.sqlite` backup was written first.
- `npm run migrate:check` on a copy of the checkpoint: every table kept the same row count, `integrity_check` returned ok, and there were 0 foreign-key violations.
- After the upgrade the live database still has 1 organization, 2 users, 1 ticket and 4 devices.

## What was built

- **Accounts and security:** invitations, TOTP two-factor (required for staff), CSRF tokens, same-origin checks, rate limits, session list and revoke, suspension, and an audit log with CSV export.
- **Helpdesk:** ticket numbers, categories, impact, a status workflow, assignment, replies, internal notes, work logs, attachments (content-sniffed, 5 MB), customer reopen and close, and auto-close.
- **SLA:** policies per plan and priority, business hours and holidays for Africa/Kampala, a paused clock while waiting on the customer, breach notifications.
- **Assets:** an asset register with assignment history, CSV export, preventive maintenance schedules and records, and a PDF report.
- **Monitoring:** HTTP, TCP and ping monitors; uptime over 24 hours, 7 days and 30 days; stale detection; incidents; maintenance windows; a customer status page. Monitoring only reports measured results.
- **Billing:** plans, subscriptions with history, invoices, and pending payments that only an administrator can verify or reject. Invoice and receipt PDFs. Duplicate payment references are rejected.
- **Reports:** a summary for each organization or for all of them, with PDF and CSV exports.
- **Email:** an SMTP outbox with retry and back-off. The status is shown in Settings.
- **MeshCentral:** health check and device sync through `meshctrl.js`. Remote launch requires consent, a reason, two-factor and an active organization, and every launch is recorded and notified.
- **Operations:** nightly encrypted backups with retention, a restore that checks integrity first, a production start-up guard, graceful shutdown, a Dockerfile and Compose files, and a load test.
- **UI:** new responsive single-page app (`public/js/*`) with light and dark themes, the unaltered OSVIA logo, role-based navigation and dashboards, accessible forms and tables, and a mobile layout.

## Verification actually performed

| Check | Result |
| --- | --- |
| `npm test` (44 tests, 14 suites) | 44 passed, 0 failed |
| `npm audit` | 0 vulnerabilities |
| `npm run migrate:check` on the pre-upgrade copy | row counts equal, integrity ok, 0 FK errors |
| Browser: throwaway instance, admin setup, two-factor enrollment, every admin page | all pages loaded, no script errors |
| Browser: ticket assign and reply, SLA first response recorded as met | worked |
| Browser: invitation accepted as a customer user, ticket created, staff-only pages and APIs refused (403/404) | worked |
| Browser: dark theme and 390 px mobile width (no horizontal scroll) | worked |
| Device check against a real TCP port | reported online from a real check |
| `npm run loadtest` (25 workers, 20 s, separate server process) | 3,421 requests, 170 req/s, 0 errors, p95 ≈ 200–240 ms |
| Load test with 1 worker | 218 req/s, p50 1–8 ms per endpoint |

Problems found and fixed during browser testing: a stray "null" text in dialogs, logos cropped by CSS, dialogs staying open after navigation, scripts cached for 5 minutes after an upgrade, and the customer-user ticket page subtitle.

## Not verified / limitations

- **MeshCentral** has only been tested against a fake `meshctrl`. The `--logindomain` option and the login-key flow must be checked on a live server (`docs/MESHCENTRAL.md`).
- **Docker** files were not built or run (Docker is not installed on this PC).
- **SMTP** was tested with a fake transport only. No real email was sent.
- **Mobile money:** there is no payment-provider integration. Payments are manual and pending until verified.
- The real administrator account was not signed in during testing; that is for the owner to do.
- SQLite in one process is a single point of failure; there is no replication.

## Suggested next steps

1. Sign in with the real administrator account, turn on two-factor, and set `BACKUP_KEY`.
2. Configure SMTP and send a test invitation.
3. Set up MeshCentral on the server and follow `docs/MESHCENTRAL.md` step by step.
4. Build the Docker image on the server, then put it behind HTTPS with `NODE_ENV=production`.
5. Schedule off-machine copies of `data/backups` and `data/uploads`, and test a restore.
