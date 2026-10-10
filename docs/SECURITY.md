# Security notes

## Controls in place

- Passwords hashed with scrypt. No default accounts; the first administrator is created on the setup page (optionally protected by `SETUP_TOKEN`).
- Two-factor authentication (TOTP) required for administrators and technicians. Staff without it can only reach their account page.
- Session cookies are HttpOnly and SameSite=Lax, and also Secure when `COOKIE_SECURE=true`. Sessions expire after `SESSION_IDLE_MINUTES` of inactivity, and suspending an organization ends its sessions.
- Every state-changing request needs the per-session CSRF token and a same-origin `Origin`/`Referer`.
- Rate limits on sign-in, registration, invitation and password endpoints.
- Every permission is checked on the server. Customers only ever receive data for their own organization. Customer users only see their own tickets and assigned devices.
- Strict Content-Security-Policy (no inline scripts or styles), `X-Frame-Options`-equivalent `frame-ancestors 'none'`, and no third-party scripts.
- Uploads limited to 5 MB and to PNG, JPEG, PDF and plain text, detected from file contents. Downloads are served as attachments with a sandbox CSP.
- Payments stay *pending* until an administrator confirms the money arrived. Only then are invoices marked paid and subscriptions activated. The portal does not connect to any mobile-money API.
- MeshCentral credentials stay on the server (see `MESHCENTRAL.md`).
- Audit log of sign-ins, permission changes, billing actions, remote sessions and settings changes.

## Known risks and limits

- **Hosting from an office or home connection:** a residential line usually has a changing IP address, no uptime guarantee, and an ISP that may block inbound ports. Opening ports on the router exposes this PC to the internet. Prefer a VPS or a tunnel (for example Cloudflare Tunnel) with HTTPS, and keep this PC patched and its disk encrypted.
- SQLite runs in one process. That is fine for the expected load (see the load test in `DEPLOYMENT.md`) but is not highly available.
- If `BACKUP_KEY` is empty, backups are not encrypted.
- With `MESHCENTRAL_PASSWORD_FILE`, the MeshCentral password is visible in the process list while `meshctrl` runs. Use a login key file.
- Email delivery depends on your SMTP provider. Failed emails are retried and shown under **Settings → System**.

## Reporting a problem

Email the OSVIA administrator listed in `CONTACT_EMAIL`. Do not post vulnerability details in public chats.
