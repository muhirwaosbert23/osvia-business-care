# Troubleshooting

**"Port 3080 is already in use."**
Another copy is still running. On Windows: `netstat -ano | findstr :3080`, then check the process with `tasklist /FI "PID eq <pid>"` before you stop it. Change `PORT` in `.env` if another service legitimately owns the port.

**"Refusing to start in production"**
`NODE_ENV=production` needs `COOKIE_SECURE=true`, an `https://` `APP_URL` and staff two-factor turned on. Use `NODE_ENV=development` for local testing.

**Staff are sent to the Account page after signing in**
They have not turned on two-factor authentication. Use **Account → Set up two-factor**. An administrator can reset someone's two-factor from the OSVIA team page if they lose their phone.

**Two-factor codes are always rejected**
Check the PC and phone clocks. If `APP_SECRET` or `data/app-secret.key` changed, existing enrollments cannot be read; reset two-factor for the affected users.

**Invitation emails do not arrive**
Without `SMTP_HOST` and `SMTP_FROM` the portal shows the invitation link on screen instead. With SMTP set, look at **Settings → System → Email queue** for the error. Failed emails are retried automatically.

**A device always shows "Unknown" or "Not checked"**
The portal only reports a status it has verified. Add a check address (IP or host name, and a port if ping is blocked) on the device, or link it through MeshCentral. A firewall that drops ping and the chosen port makes the device show as offline.

**A monitor shows "Stale"**
No check result has arrived within twice its interval. Check that background jobs are running (`DISABLE_JOBS` is not `true`) and look at **Settings → System → Monitoring checks**.

**MeshCentral shows "Error"**
Run the same command by hand: `node <MESHCTRL_PATH> serverinfo --json --url <MESHCENTRAL_CONTROL_URL> --loginuser <user> --loginkeyfile <file>`. Fix what it reports first. See `MESHCENTRAL.md`.

**The browser shows an old page after an upgrade**
Scripts and styles are served with `Cache-Control: no-cache`; a normal reload picks up the new version.

**Restoring data**
See `BACKUP.md`. Always stop the portal before restoring.
