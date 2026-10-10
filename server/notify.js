import { setHealth } from "./db.js";
import { nowIso } from "./validate.js";

const RETRY_MINUTES = [1, 5, 30, 120];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

export function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

export function appUrl() {
  return (process.env.APP_URL || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3080}`).replace(/\/+$/, "");
}

export function queueEmail(db, { to, subject, text, kind, dedupeKey = null }) {
  const now = nowIso();
  if (!smtpConfigured()) {
    db.prepare(`
      INSERT OR IGNORE INTO email_outbox (to_email, subject, body_text, kind, dedupe_key, status, attempts, next_attempt_at, last_error, created_at)
      VALUES (?, ?, NULL, ?, ?, 'skipped', 0, ?, 'SMTP is not configured', ?)
    `).run(to, subject, kind, dedupeKey, now, now);
    return false;
  }
  db.prepare(`
    INSERT OR IGNORE INTO email_outbox (to_email, subject, body_text, kind, dedupe_key, status, attempts, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `).run(to, subject, text, kind, dedupeKey, now, now);
  return true;
}

export function notifyUsers(db, userIds, { title, body, kind = "general", link = null, marker = null, email = true }) {
  const unique = [...new Set(userIds.filter(Boolean))];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO notifications (user_id, title, body, marker, kind, link, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const userId of unique) {
    const user = db.prepare("SELECT id, email, active, email_notifications FROM users WHERE id = ?").get(userId);
    if (!user || user.active !== 1) continue;
    const result = insert.run(user.id, title, body, marker, kind, link, nowIso());
    if (marker && result.changes === 0) continue;
    if (email && user.email_notifications === 1) {
      const url = link ? `${appUrl()}/#/${link}` : appUrl();
      queueEmail(db, {
        to: user.email,
        subject: `[OSVIA Business Care] ${title}`,
        text: `${body}\n\nOpen: ${url}\n\nOSVIA TECHNOLOGIES, Kampala. You can turn email notifications off under Account settings.`,
        kind,
        dedupeKey: marker ? `${marker}:${user.id}` : null,
      });
    }
  }
}

export function staffIds(db, roles = ["admin", "technician"]) {
  const marks = roles.map(() => "?").join(",");
  return db.prepare(`SELECT id FROM users WHERE active = 1 AND role IN (${marks})`).all(...roles).map((row) => row.id);
}

export function customerAdminIds(db, organizationId) {
  return db.prepare("SELECT id FROM users WHERE active = 1 AND organization_id = ? AND role = 'customer_admin'").all(organizationId).map((row) => row.id);
}

let cachedTransport = null;

async function defaultTransport() {
  if (cachedTransport) return cachedTransport;
  const nodemailer = (await import("nodemailer")).default;
  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    requireTLS: process.env.SMTP_SECURE !== "true" && process.env.SMTP_REQUIRE_TLS !== "false",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || "" } : undefined,
    connectionTimeout: 15000,
    socketTimeout: 20000,
  });
  return cachedTransport;
}

function safeError(error) {
  return String(error?.code || error?.responseCode || error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 200);
}

export async function deliverOutbox(db, { transport = null, now = new Date() } = {}) {
  if (!smtpConfigured() && !transport) {
    setHealth(db, "smtp", "not_configured", "Set SMTP_HOST and SMTP_FROM to send email.");
    return { sent: 0, failed: 0 };
  }
  const due = db.prepare(`
    SELECT * FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT 20
  `).all(now.toISOString());
  let sent = 0;
  let failed = 0;
  const mailer = transport || await defaultTransport();
  for (const message of due) {
    try {
      await mailer.sendMail({ from: process.env.SMTP_FROM || "OSVIA Business Care <no-reply@localhost>", to: message.to_email, subject: message.subject, text: message.body_text || "" });
      db.prepare("UPDATE email_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, body_text = NULL, last_error = NULL WHERE id = ?").run(nowIso(), message.id);
      sent += 1;
    } catch (error) {
      const attempts = message.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare("UPDATE email_outbox SET status = 'failed', attempts = ?, last_error = ?, body_text = NULL WHERE id = ?").run(attempts, safeError(error), message.id);
      } else {
        const next = new Date(now.getTime() + RETRY_MINUTES[attempts - 1] * 60000).toISOString();
        db.prepare("UPDATE email_outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?").run(attempts, safeError(error), next, message.id);
      }
      failed += 1;
    }
  }
  if (due.length) {
    setHealth(db, "smtp", failed && !sent ? "error" : "ok", failed ? `${failed} message(s) failed in the last run.` : `${sent} message(s) sent.`);
  } else if (!db.prepare("SELECT 1 FROM integration_health WHERE name = 'smtp'").get()) {
    setHealth(db, "smtp", "ok", "Configured. No messages sent yet.");
  }
  return { sent, failed };
}
