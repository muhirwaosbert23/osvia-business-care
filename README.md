# OSVIA Business Care

Local support portal for OSVIA Technologies, Kampala. It runs on this Windows PC with Node.js and a SQLite file. Docker and MeshCentral are not part of this setup.

## Technologies

- Node.js 22 or newer (this PC has Node 24)
- Built-in `node:sqlite` for organizations, users, tickets, devices, plans, payments, and audit events
- Browser pages served by the same Node process
- Passwords stored with scrypt
- Session cookies marked HttpOnly

## Start

```bat
node --experimental-sqlite server\index.js
```

Or double-click `start.cmd`.

Open http://127.0.0.1:3080

The first page creates the administrator. There is no default password. After that, staff can add organizations, and a customer can register from the sign-in page.

Copy `.env.example` to `.env` to change the port or add a public contact email and phone.

## Tests

```bat
npm test
```

## What works locally

- Administrator setup, sign-in, and organization registration
- Customer accounts see only their own organization, devices, tickets, and payments
- Tickets can be assigned, noted, and resolved
- Device inventory with consent. Enter an IP address or hostname and the portal pings it, or connects to a port you choose, then shows Online or Offline. Devices without an address stay not checked.
- Service plans in UGX, manual payment records, and administrator activation
- Maintenance records and a PDF built from those stored rows
- In-app notifications and renewal reminders
- Audit log
- SQLite backup through `VACUUM INTO`
- Restarting the process keeps the database file in `data\osvia.sqlite`

## What is not running

- MeshCentral, remote desktop, and device agents
- Email. Notifications stay inside the portal until SMTP is configured
- Mobile-money collection. A payment is only a record until an administrator confirms it
- HTTPS. The server listens on `127.0.0.1`
- Docker, the Kali server, and the existing Ontike or Uptime Kuma apps

## Backup

1. Sign in as the administrator and keep a copy from `data\backups`, or stop the server and copy `data\osvia.sqlite`.
2. To restore, stop the server, replace `data\osvia.sqlite` with that copy, and start the server again.
3. Sign in and confirm the organization you expect is present.

Do not commit `data\` or `.env`.
