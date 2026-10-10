# Backup and restore

## What to keep

| Item | Where | Why |
| --- | --- | --- |
| Database | `DATA_DIR/osvia.sqlite` (copied into `DATA_DIR/backups`) | All customer, ticket, device, billing and audit data |
| Application secret | `APP_SECRET` in `.env`, or `DATA_DIR/app-secret.key` | Decrypts stored two-factor secrets. Without it every staff member must re-enroll two-factor |
| Backup key | `BACKUP_KEY` in `.env` | Decrypts `.enc` backups. Without it encrypted backups are useless |
| Attachments | `DATA_DIR/uploads` | Files attached to tickets |

Keep `APP_SECRET`/`app-secret.key` and `BACKUP_KEY` in a password manager, not next to the backups.

## Automatic backups

The portal writes `osvia-nightly-<time>.sqlite` (or `.sqlite.enc` when `BACKUP_KEY` is set) once a day and keeps the newest `BACKUP_KEEP` (default 14). Backups made before a migration (`premigration-*`) and manual checkpoints are never deleted automatically.

Administrators can also create a backup from **Settings → Backups**. The file stays on the server; the portal does not offer it for download.

Copy `DATA_DIR/backups` and `DATA_DIR/uploads` to another machine or cloud storage regularly. A backup on the same disk does not protect against disk failure or theft.

## Manual backup

```bat
npm run backup
```

Plain backups are integrity-checked and their row counts are printed.

## Restore

1. Stop the portal.
2. Make sure `BACKUP_KEY` in `.env` is the key that was used for the backup (for `.enc` files).
3. Run:

   ```bat
   npm run restore -- data\backups\osvia-nightly-2026-10-10T07-38-24-689Z.sqlite
   ```

   The file is decrypted to a staging copy and checked with `PRAGMA integrity_check`. Only then is the current database replaced. The previous database is kept as `osvia.sqlite.before-restore-<time>`.
4. Restore `uploads` from the same date if you have it.
5. Start the portal, sign in, and check that the expected organizations and recent tickets are present.

Test a restore on a spare machine at least once a quarter.
