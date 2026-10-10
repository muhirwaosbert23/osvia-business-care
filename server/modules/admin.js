import fs from "node:fs";
import path from "node:path";
import { isStaff, requireRole, requireStaff } from "../auth.js";
import { backupDatabase, pruneBackups } from "../backup.js";
import { streamCsv } from "../csv.js";
import { audit, schemaVersion } from "../db.js";
import { HttpError } from "../errors.js";
import { startStream } from "../http.js";
import { checkHealth, meshConfigured, syncDevices } from "../meshcentral.js";
import { meshIncidents, monitorFreshness } from "../monitoring.js";
import { smtpConfigured } from "../notify.js";
import { assertEmail, assertInt, assertText, likePattern, nowIso, optionalText, pageParams, todayUtc } from "../validate.js";

const ACTIVE = "('new','open','in_progress','pending_customer')";

function deviceCounts(db, where, args) {
  return db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN reachability = 'online' THEN 1 ELSE 0 END) AS online,
      SUM(CASE WHEN reachability = 'offline' THEN 1 ELSE 0 END) AS offline,
      SUM(CASE WHEN reachability = 'unknown' THEN 1 ELSE 0 END) AS unknown
    FROM devices WHERE archived_at IS NULL AND ${where}
  `).get(...args);
}

function recentTickets(db, where, args) {
  return db.prepare(`
    SELECT t.id, t.number, t.title, t.status, t.priority, t.created_at, t.response_due_at, t.response_breached, t.resolution_breached, o.name AS organization_name
    FROM tickets t JOIN organizations o ON o.id = t.organization_id WHERE ${where} ORDER BY t.updated_at DESC LIMIT 6
  `).all(...args).map((t) => ({ id: t.id, number: t.number, title: t.title, status: t.status, priority: t.priority, createdAt: t.created_at, responseDueAt: t.response_due_at, breached: Boolean(t.response_breached || t.resolution_breached), organizationName: t.organization_name }));
}

function health(db) {
  const rows = db.prepare("SELECT * FROM integration_health ORDER BY name").all();
  const map = Object.fromEntries(rows.map((r) => [r.name, { status: r.status, detail: r.detail || "", checkedAt: r.checked_at }]));
  for (const [name, maxAgeMinutes] of [["monitor_runner", 10], ["meshcentral", 30], ["scheduler", 10]]) {
    const item = map[name];
    if (item && item.status === "ok" && Date.now() - Date.parse(item.checkedAt) > maxAgeMinutes * 60000) {
      item.status = "stale";
      item.detail = `No successful update since ${item.checkedAt}. ${item.detail}`;
    }
  }
  if (!map.meshcentral) map.meshcentral = { status: meshConfigured() ? "unknown" : "not_configured", detail: meshConfigured() ? "Not checked yet." : "MeshCentral is not configured.", checkedAt: null };
  if (!map.smtp) map.smtp = { status: smtpConfigured() ? "unknown" : "not_configured", detail: smtpConfigured() ? "No email sent yet." : "SMTP is not configured; email notifications are skipped.", checkedAt: null };
  return map;
}

function ticketTrend(db, scope, args) {
  const days = 14;
  const start = new Date(Date.now() + 3 * 3600000 - (days - 1) * 86400000).toISOString().slice(0, 10);
  const count = (column) => Object.fromEntries(db.prepare(`
    SELECT date(${column}, '+3 hours') AS day, COUNT(*) AS n FROM tickets t
    WHERE ${column} IS NOT NULL AND date(${column}, '+3 hours') >= ? AND ${scope} GROUP BY day
  `).all(start, ...args).map((r) => [r.day, r.n]));
  const opened = count("t.created_at");
  const resolved = count("t.resolved_at");
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(Date.parse(`${start}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    return { day, opened: opened[day] || 0, resolved: resolved[day] || 0 };
  });
}

function dashboard({ db, actor }) {
  const today = todayUtc();
  const soon = new Date(Date.now() + 2 * 3600000).toISOString();
  if (isStaff(actor)) {
    const ticketScope = actor.role === "admin" ? "1 = 1" : "(t.assigned_to = ? OR t.assigned_to IS NULL)";
    const ticketArgs = actor.role === "admin" ? [] : [actor.id];
    const tickets = db.prepare(`
      SELECT
        SUM(CASE WHEN t.status IN ${ACTIVE} THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN t.status IN ${ACTIVE} AND t.assigned_to IS NULL THEN 1 ELSE 0 END) AS unassigned,
        SUM(CASE WHEN t.status IN ${ACTIVE} AND t.assigned_to = ? THEN 1 ELSE 0 END) AS mine,
        SUM(CASE WHEN t.status IN ${ACTIVE} AND (t.response_breached = 1 OR t.resolution_breached = 1) THEN 1 ELSE 0 END) AS breached,
        SUM(CASE WHEN t.status IN ${ACTIVE} AND t.first_response_at IS NULL AND t.response_due_at IS NOT NULL AND t.response_due_at <= ? AND t.response_due_at > ? THEN 1 ELSE 0 END) AS due_soon,
        SUM(CASE WHEN t.status IN ${ACTIVE} AND t.priority = 'urgent' THEN 1 ELSE 0 END) AS urgent
      FROM tickets t WHERE ${ticketScope}
    `).get(actor.id, soon, nowIso(), ...ticketArgs);
    const monitors = db.prepare("SELECT * FROM monitors WHERE active = 1").all();
    const freshness = monitors.map((m) => monitorFreshness(m));
    const data = {
      role: actor.role,
      tickets: { open: tickets.open || 0, unassigned: tickets.unassigned || 0, mine: tickets.mine || 0, breached: tickets.breached || 0, dueSoon: tickets.due_soon || 0, urgent: tickets.urgent || 0 },
      devices: deviceCounts(db, "1 = 1", []),
      incidentsOpen: db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE status = 'open'").get().n,
      monitors: { total: monitors.length, down: freshness.filter((s) => s === "down").length, stale: freshness.filter((s) => s === "stale").length, unknown: freshness.filter((s) => s === "unknown").length },
      maintenanceOverdue: db.prepare("SELECT COUNT(*) AS n FROM maintenance_schedules WHERE active = 1 AND next_due < ?").get(today).n,
      maintenanceDueWeek: db.prepare("SELECT COUNT(*) AS n FROM maintenance_schedules WHERE active = 1 AND next_due BETWEEN ? AND date(?, '+7 days')").get(today, today).n,
      recentTickets: recentTickets(db, `t.status IN ${ACTIVE} AND ${ticketScope}`, ticketArgs),
      health: health(db),
      byStatus: Object.fromEntries(db.prepare(`SELECT t.status, COUNT(*) AS n FROM tickets t WHERE t.status IN ${ACTIVE} AND ${ticketScope} GROUP BY t.status`).all(...ticketArgs).map((r) => [r.status, r.n])),
      byPriority: Object.fromEntries(db.prepare(`SELECT t.priority, COUNT(*) AS n FROM tickets t WHERE t.status IN ${ACTIVE} AND ${ticketScope} GROUP BY t.priority`).all(...ticketArgs).map((r) => [r.priority, r.n])),
      trend: ticketTrend(db, ticketScope, ticketArgs),
    };
    if (actor.role === "admin") {
      Object.assign(data, {
        organizationsPending: db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE status = 'pending'").get().n,
        organizationsActive: db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE status = 'active'").get().n,
        paymentsPending: db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'").get().n,
        invoicesOverdue: db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'issued' AND due_date < ?").get(today).n,
        renewalsDue: db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE subscription_status = 'active' AND renewal_date <= date(?, '+14 days')").get(today).n,
        emailFailed: db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'failed'").get().n,
        finance: db.prepare(`
          SELECT (SELECT COALESCE(SUM(amount_ugx), 0) FROM payments WHERE status = 'verified' AND confirmed_at >= ?) AS verifiedThisMonth,
                 (SELECT COALESCE(SUM(amount_ugx), 0) FROM payments WHERE status = 'pending') AS pendingAmount,
                 (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE status = 'issued') AS outstanding
        `).get(`${today.slice(0, 7)}-01`),
        activity: db.prepare(`
          SELECT a.action, a.entity_type, a.entity_id, a.created_at, u.name AS actor_name, o.name AS organization_name
          FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN organizations o ON o.id = a.organization_id
          ORDER BY a.id DESC LIMIT 8
        `).all().map((a) => ({ action: a.action, entityType: a.entity_type, entityId: a.entity_id, at: a.created_at, actorName: a.actor_name || "System", organizationName: a.organization_name || "" })),
      });
    }
    return data;
  }
  const orgId = actor.organizationId;
  const org = db.prepare("SELECT o.*, p.name AS plan_name FROM organizations o LEFT JOIN service_plans p ON p.id = o.plan_id WHERE o.id = ?").get(orgId);
  const mine = actor.role === "customer_user";
  const ticketWhere = mine ? "t.organization_id = ? AND t.created_by = ?" : "t.organization_id = ?";
  const ticketArgs = mine ? [orgId, actor.id] : [orgId];
  const data = {
    role: actor.role,
    organization: { name: org.name, status: org.status, planName: org.plan_name || "", subscriptionStatus: org.subscription_status, renewalDate: org.renewal_date, suspensionReason: org.suspension_reason || "" },
    tickets: db.prepare(`
      SELECT SUM(CASE WHEN t.status IN ${ACTIVE} THEN 1 ELSE 0 END) AS open,
             SUM(CASE WHEN t.status = 'pending_customer' THEN 1 ELSE 0 END) AS waiting_on_you,
             SUM(CASE WHEN t.status = 'resolved' THEN 1 ELSE 0 END) AS resolved
      FROM tickets t WHERE ${ticketWhere}
    `).get(...ticketArgs),
    devices: deviceCounts(db, mine ? "organization_id = ? AND assigned_user_id = ?" : "organization_id = ?", mine ? [orgId, actor.id] : [orgId]),
    incidentsOpen: db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE organization_id = ? AND status = 'open' AND customer_visible = 1").get(orgId).n,
    upcomingMaintenance: db.prepare("SELECT title, next_due FROM maintenance_schedules WHERE organization_id = ? AND active = 1 ORDER BY next_due LIMIT 5").all(orgId).map((m) => ({ title: m.title, nextDue: m.next_due })),
    windows: db.prepare("SELECT title, starts_at, ends_at FROM maintenance_windows WHERE (organization_id IS NULL OR organization_id = ?) AND ends_at > ? ORDER BY starts_at LIMIT 3").all(orgId, nowIso()).map((w) => ({ title: w.title, startsAt: w.starts_at, endsAt: w.ends_at })),
    recentTickets: recentTickets(db, ticketWhere, ticketArgs),
  };
  data.tickets = { open: data.tickets.open || 0, waitingOnYou: data.tickets.waiting_on_you || 0, resolved: data.tickets.resolved || 0 };
  if (!mine) {
    data.billing = db.prepare(`
      SELECT (SELECT COUNT(*) FROM invoices WHERE organization_id = ? AND status = 'issued') AS unpaid,
             (SELECT COUNT(*) FROM invoices WHERE organization_id = ? AND status = 'issued' AND due_date < ?) AS overdue,
             (SELECT COUNT(*) FROM payments WHERE organization_id = ? AND status = 'pending') AS pending
    `).get(orgId, orgId, todayUtc(), orgId);
    const steps = [
      org.status === "active",
      org.subscription_status === "active",
      db.prepare("SELECT COUNT(*) AS n FROM devices WHERE organization_id = ? AND archived_at IS NULL").get(orgId).n > 0,
      db.prepare("SELECT COUNT(*) AS n FROM devices WHERE organization_id = ? AND consent_at IS NOT NULL").get(orgId).n > 0,
    ];
    data.onboardingIncomplete = steps.some((done) => !done);
  }
  return data;
}

function listNotifications({ db, actor, url }) {
  const { page, limit, offset } = pageParams(url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const where = `user_id = ?${unreadOnly ? " AND read_at IS NULL" : ""}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`).get(actor.id).n;
  const unread = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(actor.id).n;
  const items = db.prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(actor.id, limit, offset).map((n) => ({ id: n.id, title: n.title, body: n.body, kind: n.kind || "general", link: n.link, readAt: n.read_at, createdAt: n.created_at }));
  return { items, unread, page, pageSize: limit, total };
}

function readNotification({ db, actor, params }) {
  const info = db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?").run(nowIso(), params.id, actor.id);
  if (!info.changes) throw new HttpError(404, "Not found.");
  return { ok: true };
}

function readAll({ db, actor }) {
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(nowIso(), actor.id);
  return { ok: true };
}

function auditFilters(actor, url) {
  const where = [];
  const args = [];
  if (actor.role === "customer_admin") {
    where.push("a.organization_id = ?");
    args.push(actor.organizationId);
  } else {
    requireRole(actor, "admin");
    if (url.searchParams.get("organizationId")) where.push("a.organization_id = ?"), args.push(Number(url.searchParams.get("organizationId")));
  }
  const p = url.searchParams;
  if (p.get("action")) where.push("a.action LIKE ? ESCAPE '\\'"), args.push(likePattern(p.get("action").slice(0, 60)));
  if (p.get("actor")) where.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')"), args.push(likePattern(p.get("actor").slice(0, 60)), likePattern(p.get("actor").slice(0, 60)));
  if (p.get("from")) where.push("a.created_at >= ?"), args.push(`${p.get("from").slice(0, 10)}T00:00:00.000Z`);
  if (p.get("to")) where.push("a.created_at < date(?, '+1 day')"), args.push(p.get("to").slice(0, 10));
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

const AUDIT_SELECT = "SELECT a.*, u.name AS actor_name, u.email AS actor_email FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id";

function mapAudit(a, actor) {
  return { id: a.id, actorName: a.actor_name || "System", actorEmail: a.actor_email || "", action: a.action, entityType: a.entity_type, entityId: a.entity_id, organizationId: a.organization_id, detail: a.detail ? JSON.parse(a.detail) : null, ip: actor.role === "admin" ? a.ip : undefined, createdAt: a.created_at };
}

function listAudit({ db, actor, url }) {
  const { page, limit, offset } = pageParams(url);
  const { clause, args } = auditFilters(actor, url);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id ${clause}`).get(...args).n;
  const items = db.prepare(`${AUDIT_SELECT} ${clause} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map((a) => mapAudit(a, actor));
  return { items, page, pageSize: limit, total };
}

function auditCsv({ db, actor, url, res }) {
  const { clause, args } = auditFilters(actor, url);
  startStream(res, { type: "text/csv; charset=utf-8", filename: `osvia-audit-${todayUtc()}.csv` });
  streamCsv(res, ["Time", "Actor", "Action", "Entity", "Entity ID", "Organization", "IP", "Detail"],
    (limit, offset) => db.prepare(`${AUDIT_SELECT} ${clause} ORDER BY a.id LIMIT ? OFFSET ?`).all(...args, limit, offset),
    (a) => [a.created_at, a.actor_email || "system", a.action, a.entity_type, a.entity_id, a.organization_id, actor.role === "admin" ? a.ip : "", a.detail]);
}

const EDITABLE_SETTINGS = {
  support_email: (v) => (String(v || "").trim() ? assertEmail(v) : ""),
  support_phone: (v) => optionalText(v, 40, "Support phone"),
  invoice_prefix: (v) => {
    const text = String(v || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(text)) throw new HttpError(400, "The invoice prefix uses 1 to 8 letters or digits.");
    return text;
  },
  invoice_due_days: (v) => String(assertInt(v, "Invoice due days", 1, 90)),
  reopen_days: (v) => String(assertInt(v, "Reopen window (days)", 1, 90)),
  auto_close_days: (v) => String(assertInt(v, "Auto-close after (days)", 1, 60)),
  escalation_text: (v) => assertText(v, "Escalation guidance", 1000),
};

function getSettings({ db, actor }) {
  requireRole(actor, "admin");
  const rows = db.prepare("SELECT key, value FROM settings").all();
  return { settings: Object.fromEntries(rows.filter((r) => r.key in EDITABLE_SETTINGS || r.key.startsWith("default_")).map((r) => [r.key, r.value])) };
}

function updateSettings({ db, actor, body }) {
  requireRole(actor, "admin");
  const upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const changed = [];
  for (const [key, validate] of Object.entries(EDITABLE_SETTINGS)) {
    if (body[key] === undefined) continue;
    upsert.run(key, validate(body[key]));
    changed.push(key);
  }
  audit(db, actor.id, "settings.update", "settings", null, null, { changed }, actor.ip);
  return getSettings({ db, actor });
}

function system({ db, actor }) {
  requireStaff(actor);
  const outbox = db.prepare("SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status").all();
  return {
    health: health(db),
    schemaVersion: schemaVersion(db),
    meshConfigured: meshConfigured(),
    smtpConfigured: smtpConfigured(),
    staffMfaRequired: process.env.REQUIRE_STAFF_MFA !== "false",
    backupEncrypted: Boolean(process.env.BACKUP_KEY),
    outbox: Object.fromEntries(outbox.map((r) => [r.status, r.n])),
    recentEmailErrors: actor.role === "admin" ? db.prepare("SELECT id, to_email, subject, attempts, last_error, created_at FROM email_outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 10").all() : [],
  };
}

async function meshCheck({ db, actor }) {
  requireRole(actor, "admin");
  const result = await checkHealth(db);
  audit(db, actor.id, "meshcentral.check", "integration", "meshcentral", null, { status: result.status }, actor.ip);
  return result;
}

async function meshSync({ db, actor }) {
  requireStaff(actor);
  const result = await syncDevices(db);
  if (result.status === "ok") meshIncidents(db);
  audit(db, actor.id, "meshcentral.sync", "integration", "meshcentral", null, { status: result.status, created: result.created, updated: result.updated }, actor.ip);
  return result;
}

function backupDir() {
  return path.resolve(process.env.DATA_DIR || "data", "backups");
}

function listBackups({ actor }) {
  requireRole(actor, "admin");
  const dir = backupDir();
  if (!fs.existsSync(dir)) return { items: [] };
  const items = fs.readdirSync(dir).filter((name) => /\.(sqlite|enc)$/.test(name)).map((name) => {
    const stat = fs.statSync(path.join(dir, name));
    return { name, size: stat.size, createdAt: stat.mtime.toISOString(), encrypted: name.endsWith(".enc") };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items, directory: "DATA_DIR/backups", encryptionConfigured: Boolean(process.env.BACKUP_KEY) };
}

function createBackup({ db, actor }) {
  requireRole(actor, "admin");
  const file = backupDatabase(db, backupDir(), { label: "osvia-manual" });
  pruneBackups(backupDir(), Number(process.env.BACKUP_KEEP || 14));
  audit(db, actor.id, "backup.create", "backup", path.basename(file), null, null, actor.ip);
  return { name: path.basename(file), message: "Backup written on the server. Copy the backups folder to another machine or drive." };
}

export const routes = [
  ["GET", "/api/dashboard", dashboard],
  ["GET", "/api/notifications", listNotifications, { mfaExempt: true }],
  ["POST", "/api/notifications/:id/read", readNotification, { mfaExempt: true }],
  ["POST", "/api/notifications/read-all", readAll, { mfaExempt: true }],
  ["GET", "/api/audit", listAudit],
  ["GET", "/api/audit/export.csv", auditCsv],
  ["GET", "/api/settings", getSettings],
  ["PATCH", "/api/settings", updateSettings],
  ["GET", "/api/system", system],
  ["POST", "/api/integrations/meshcentral/check", meshCheck],
  ["POST", "/api/integrations/meshcentral/sync", meshSync],
  ["GET", "/api/admin/backups", listBackups],
  ["POST", "/api/admin/backups", createBackup],
];
