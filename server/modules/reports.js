import { isStaff, scopeOrgId } from "../auth.js";
import { streamCsv } from "../csv.js";
import { audit } from "../db.js";
import { HttpError } from "../errors.js";
import { sendFile, startStream } from "../http.js";
import { buildPdf } from "../pdf.js";
import { nowIso, reportPeriod } from "../validate.js";
import { mustOrg } from "./organizations.js";

function access(actor, url) {
  if (actor.role === "customer_user") throw new HttpError(403, "Reports are available to your organization administrator.");
  if (!isStaff(actor)) return actor.organizationId;
  const requested = url.searchParams.get("organizationId");
  return requested ? scopeOrgId(actor, requested) : null;
}

function orgClause(alias, organizationId) {
  return organizationId ? { sql: `${alias}.organization_id = ?`, args: [organizationId] } : { sql: "1 = 1", args: [] };
}

export function buildReport(db, actor, organizationId, period) {
  const { fromIso, toIso, from, to } = period;
  const t = orgClause("t", organizationId);
  const tickets = db.prepare(`
    SELECT
      COUNT(*) AS created,
      SUM(CASE WHEN t.resolved_at IS NOT NULL AND t.resolved_at < ? THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN t.response_due_at IS NOT NULL THEN 1 ELSE 0 END) AS with_response_target,
      SUM(CASE WHEN t.response_due_at IS NOT NULL AND t.first_response_at IS NOT NULL AND t.first_response_at <= t.response_due_at THEN 1 ELSE 0 END) AS response_met,
      SUM(CASE WHEN t.resolution_due_at IS NOT NULL AND t.resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS with_resolution_target,
      SUM(CASE WHEN t.resolution_due_at IS NOT NULL AND t.resolved_at IS NOT NULL AND t.resolution_breached = 0 THEN 1 ELSE 0 END) AS resolution_met,
      AVG(CASE WHEN t.first_response_at IS NOT NULL THEN (julianday(t.first_response_at) - julianday(t.created_at)) * 1440 END) AS avg_response_min,
      AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 END) AS avg_resolution_hours
    FROM tickets t WHERE ${t.sql} AND t.created_at >= ? AND t.created_at < ?
  `).get(toIso, ...t.args, fromIso, toIso);
  const openNow = db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${t.sql} AND t.status IN ('new','open','in_progress','pending_customer')`).get(...t.args).n;
  const byPriority = db.prepare(`SELECT t.priority AS key, COUNT(*) AS n FROM tickets t WHERE ${t.sql} AND t.created_at >= ? AND t.created_at < ? GROUP BY t.priority ORDER BY n DESC`).all(...t.args, fromIso, toIso);
  const byCategory = db.prepare(`SELECT t.category AS key, COUNT(*) AS n FROM tickets t WHERE ${t.sql} AND t.created_at >= ? AND t.created_at < ? GROUP BY t.category ORDER BY n DESC`).all(...t.args, fromIso, toIso);

  const d = orgClause("d", organizationId);
  const devices = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN reachability = 'online' THEN 1 ELSE 0 END) AS online,
      SUM(CASE WHEN reachability = 'offline' THEN 1 ELSE 0 END) AS offline,
      SUM(CASE WHEN reachability = 'unknown' THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN warranty_expiry IS NOT NULL AND warranty_expiry <= date('now', '+60 days') THEN 1 ELSE 0 END) AS warranty_soon,
      SUM(CASE WHEN consent_at IS NOT NULL THEN 1 ELSE 0 END) AS consented
    FROM devices d WHERE ${d.sql} AND d.archived_at IS NULL
  `).get(...d.args);

  const i = orgClause("i", organizationId);
  const customerOnly = isStaff(actor) ? "" : "AND i.customer_visible = 1";
  const incidents = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN i.status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM((julianday(MIN(COALESCE(i.resolved_at, ?), ?)) - julianday(MAX(i.started_at, ?))) * 1440) AS downtime_min
    FROM incidents i WHERE ${i.sql} ${customerOnly} AND i.started_at < ? AND COALESCE(i.resolved_at, ?) > ?
  `).get(nowIso(), toIso, fromIso, ...i.args, toIso, nowIso(), fromIso);

  const m = orgClause("m", organizationId);
  const monitors = db.prepare(`
    SELECT COUNT(c.id) AS checks, SUM(c.ok) AS up, AVG(CASE WHEN c.ok = 1 THEN c.response_ms END) AS avg_ms
    FROM monitor_checks c JOIN monitors m ON m.id = c.monitor_id
    WHERE ${m.sql} ${isStaff(actor) ? "" : "AND m.customer_visible = 1"} AND c.checked_at >= ? AND c.checked_at < ?
  `).get(...m.args, fromIso, toIso);

  const r = orgClause("r", organizationId);
  const maintenance = db.prepare(`SELECT COUNT(*) AS done, COALESCE(SUM(minutes_spent), 0) AS minutes FROM maintenance_records r WHERE ${r.sql} AND r.performed_at BETWEEN ? AND ?`).get(...r.args, from, to);
  const overdueMaintenance = db.prepare(`SELECT COUNT(*) AS n FROM maintenance_schedules r WHERE ${r.sql} AND r.active = 1 AND r.next_due < date('now')`).get(...r.args).n;

  const report = {
    period: { from, to },
    organization: organizationId ? mustOrg(db, organizationId).name : "All organizations",
    generatedAt: nowIso(),
    tickets: {
      created: tickets.created,
      resolved: tickets.resolved || 0,
      openNow,
      responseSlaPercent: tickets.with_response_target ? Math.round((tickets.response_met / tickets.with_response_target) * 1000) / 10 : null,
      resolutionSlaPercent: tickets.with_resolution_target ? Math.round((tickets.resolution_met / tickets.with_resolution_target) * 1000) / 10 : null,
      avgFirstResponseMinutes: tickets.avg_response_min === null ? null : Math.round(tickets.avg_response_min),
      avgResolutionHours: tickets.avg_resolution_hours === null ? null : Math.round(tickets.avg_resolution_hours * 10) / 10,
      byPriority,
      byCategory,
    },
    devices: { total: devices.total, online: devices.online || 0, offline: devices.offline || 0, unknown: devices.unknown || 0, warrantyExpiringSoon: devices.warranty_soon || 0, consented: devices.consented || 0 },
    incidents: { total: incidents.total, open: incidents.open || 0, downtimeMinutes: Math.round(incidents.downtime_min || 0) },
    monitoring: { checks: monitors.checks, uptimePercent: monitors.checks ? Math.round((monitors.up / monitors.checks) * 10000) / 100 : null, avgResponseMs: monitors.avg_ms ? Math.round(monitors.avg_ms) : null },
    maintenance: { completed: maintenance.done, overdue: overdueMaintenance, ...(isStaff(actor) ? { minutes: maintenance.minutes } : {}) },
  };

  if (actor.role === "admin" || actor.role === "customer_admin") {
    const inv = orgClause("v", organizationId);
    const billing = db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(amount), 0) FROM invoices v WHERE ${inv.sql} AND v.status != 'void' AND v.issued_at >= ? AND v.issued_at < ?) AS invoiced,
        (SELECT COALESCE(SUM(amount_ugx), 0) FROM payments v WHERE ${inv.sql} AND v.status = 'verified' AND v.confirmed_at >= ? AND v.confirmed_at < ?) AS collected,
        (SELECT COUNT(*) FROM payments v WHERE ${inv.sql} AND v.status = 'pending') AS pending,
        (SELECT COUNT(*) FROM invoices v WHERE ${inv.sql} AND v.status = 'issued' AND v.due_date < date('now')) AS overdue
    `).get(...inv.args, fromIso, toIso, ...inv.args, fromIso, toIso, ...inv.args, ...inv.args);
    report.billing = { invoiced: billing.invoiced, collected: billing.collected, pendingPayments: billing.pending, overdueInvoices: billing.overdue, currency: "UGX" };
  }

  if (isStaff(actor)) {
    report.technicians = db.prepare(`
      SELECT u.id, u.name,
        (SELECT COUNT(*) FROM tickets t WHERE t.assigned_to = u.id AND t.resolved_at >= ? AND t.resolved_at < ? ${organizationId ? "AND t.organization_id = ?" : ""}) AS resolved,
        (SELECT COUNT(*) FROM tickets t WHERE t.assigned_to = u.id AND t.status IN ('new','open','in_progress','pending_customer') ${organizationId ? "AND t.organization_id = ?" : ""}) AS open,
        (SELECT COALESCE(SUM(n.minutes_spent), 0) FROM ticket_notes n JOIN tickets t ON t.id = n.ticket_id WHERE n.author_id = u.id AND n.created_at >= ? AND n.created_at < ? ${organizationId ? "AND t.organization_id = ?" : ""}) AS minutes
      FROM users u WHERE u.role IN ('admin', 'technician') AND u.active = 1 ORDER BY u.name
    `).all(...[fromIso, toIso, ...(organizationId ? [organizationId] : []), ...(organizationId ? [organizationId] : []), fromIso, toIso, ...(organizationId ? [organizationId] : [])]);
  }
  return report;
}

function summary({ db, actor, url }) {
  const organizationId = access(actor, url);
  return buildReport(db, actor, organizationId, reportPeriod(url));
}

const pct = (v) => (v === null ? "no data" : `${v}%`);

function pdf({ db, actor, url, res }) {
  const organizationId = access(actor, url);
  const report = buildReport(db, actor, organizationId, reportPeriod(url));
  const rows = [
    `Organization: ${report.organization}`,
    `Period: ${report.period.from} to ${report.period.to}`,
    `Generated: ${report.generatedAt.slice(0, 16).replace("T", " ")} UTC`,
    "",
    { heading: "Support tickets" },
    `Created: ${report.tickets.created}    Resolved: ${report.tickets.resolved}    Open now: ${report.tickets.openNow}`,
    `First-response SLA met: ${pct(report.tickets.responseSlaPercent)}    Resolution SLA met: ${pct(report.tickets.resolutionSlaPercent)}`,
    `Average first response: ${report.tickets.avgFirstResponseMinutes ?? "no data"} min    Average resolution: ${report.tickets.avgResolutionHours ?? "no data"} h`,
    `By priority: ${report.tickets.byPriority.map((p) => `${p.key} ${p.n}`).join(", ") || "none"}`,
    `By category: ${report.tickets.byCategory.map((p) => `${p.key.replaceAll("_", " ")} ${p.n}`).join(", ") || "none"}`,
    "",
    { heading: "Devices (current)" },
    `Registered: ${report.devices.total}    Online: ${report.devices.online}    Offline: ${report.devices.offline}    Unknown: ${report.devices.unknown}`,
    `Warranty ending within 60 days: ${report.devices.warrantyExpiringSoon}    Remote-support consent: ${report.devices.consented}`,
    "",
    { heading: "Availability" },
    `Monitor checks: ${report.monitoring.checks}    Uptime: ${pct(report.monitoring.uptimePercent)}    Average response: ${report.monitoring.avgResponseMs ?? "no data"} ms`,
    `Incidents: ${report.incidents.total}    Still open: ${report.incidents.open}    Downtime: ${report.incidents.downtimeMinutes} min`,
    "",
    { heading: "Preventive maintenance" },
    `Tasks completed: ${report.maintenance.completed}    Overdue now: ${report.maintenance.overdue}`,
  ];
  if (report.billing) {
    rows.push("", { heading: "Billing (UGX)" }, `Invoiced: ${report.billing.invoiced.toLocaleString("en-US")}    Verified payments: ${report.billing.collected.toLocaleString("en-US")}`, `Payments awaiting verification: ${report.billing.pendingPayments}    Overdue invoices: ${report.billing.overdueInvoices}`);
  }
  if (report.technicians) {
    rows.push("", { heading: "Technician workload" }, ...report.technicians.map((tech) => `${tech.name}: resolved ${tech.resolved}, open ${tech.open}, logged ${Math.round(tech.minutes / 6) / 10} h`));
  }
  audit(db, actor.id, "report.pdf", "report", null, organizationId, report.period, actor.ip);
  sendFile(res, { body: buildPdf("Service report", rows), type: "application/pdf", filename: `osvia-report-${report.period.from}-${report.period.to}.pdf` });
}

function ticketsCsv({ db, actor, url, res }) {
  const organizationId = access(actor, url);
  const { fromIso, toIso, from, to } = reportPeriod(url);
  const t = orgClause("t", organizationId);
  audit(db, actor.id, "report.csv", "report", null, organizationId, { from, to }, actor.ip);
  startStream(res, { type: "text/csv; charset=utf-8", filename: `osvia-tickets-${from}-${to}.csv` });
  streamCsv(
    res,
    ["Number", "Organization", "Subject", "Category", "Priority", "Status", "Created", "First response", "Response due", "Resolved", "Response breached", "Resolution breached", "Assignee"],
    (limit, offset) => db.prepare(`
      SELECT t.*, o.name AS organization_name, u.name AS assignee FROM tickets t JOIN organizations o ON o.id = t.organization_id LEFT JOIN users u ON u.id = t.assigned_to
      WHERE ${t.sql} AND t.created_at >= ? AND t.created_at < ? ORDER BY t.id LIMIT ? OFFSET ?
    `).all(...t.args, fromIso, toIso, limit, offset),
    (row) => [row.number, row.organization_name, row.title, row.category, row.priority, row.status, row.created_at, row.first_response_at, row.response_due_at, row.resolved_at, row.response_breached ? "yes" : "no", row.resolution_breached ? "yes" : "no", isStaff(actor) ? row.assignee : (row.assignee ? "OSVIA technician" : "")],
  );
}

export const routes = [
  ["GET", "/api/reports/summary", summary],
  ["GET", "/api/reports/summary.pdf", pdf],
  ["GET", "/api/reports/tickets.csv", ticketsCsv],
];
