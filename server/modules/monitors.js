import { isStaff, rateLimit, requireOperationalOrg, requireRole, requireStaff, scopeOrgId } from "../auth.js";
import { audit, changes, transaction } from "../db.js";
import { HttpError } from "../errors.js";
import { reply } from "../http.js";
import { assertMonitorTarget, assertPublicUrl, checkMonitor, monitorFreshness, PUBLIC_ONLY_SQL, recordMonitorResult } from "../monitoring.js";
import { customerAdminIds, notifyUsers, staffIds } from "../notify.js";
import { assertBool, assertDateTime, assertEnum, assertInt, assertText, fieldPicker, nowIso, nullableText, pageParams } from "../validate.js";
import { mustOrg } from "./organizations.js";

function mapMonitor(row, actor, stats = null) {
  const data = {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    name: row.name,
    type: row.type,
    status: monitorFreshness(row),
    lastCheckedAt: row.last_checked_at,
    lastResponseMs: row.last_response_ms,
    sslExpiresAt: row.ssl_expires_at,
    active: row.active === 1,
    intervalSeconds: row.interval_seconds,
    addedByCustomer: row.public_only === 1,
    createdByName: row.created_by_name || "",
    canManage: canManage(actor, row),
  };
  if (data.canManage && data.addedByCustomer) data.target = row.target;
  if (stats) Object.assign(data, stats);
  if (isStaff(actor)) {
    Object.assign(data, {
      target: row.target,
      port: row.port,
      timeoutMs: row.timeout_ms,
      failureThreshold: row.failure_threshold,
      expectedStatus: row.expected_status,
      sslWarningDays: row.ssl_warning_days,
      customerVisible: row.customer_visible === 1,
      lastError: row.last_error || "",
      consecutiveFailures: row.consecutive_failures,
    });
  }
  return data;
}

function uptime(db, monitorId, hours) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const row = db.prepare("SELECT COUNT(*) AS total, SUM(ok) AS up, AVG(CASE WHEN ok = 1 THEN response_ms END) AS avg_ms FROM monitor_checks WHERE monitor_id = ? AND checked_at >= ?").get(monitorId, since);
  return { checks: row.total, uptimePercent: row.total ? Math.round((row.up / row.total) * 10000) / 100 : null, avgResponseMs: row.avg_ms ? Math.round(row.avg_ms) : null };
}

function scope(actor, url, alias = "m") {
  const where = [];
  const args = [];
  if (!isStaff(actor)) {
    where.push(`${alias}.organization_id = ?`, `${alias}.customer_visible = 1`);
    args.push(actor.organizationId);
  } else if (url?.searchParams.get("organizationId")) {
    where.push(`${alias}.organization_id = ?`);
    args.push(scopeOrgId(actor, url.searchParams.get("organizationId")));
  }
  return { sql: where.length ? where.join(" AND ") : "1 = 1", args };
}

const MONITOR_SELECT = `SELECT m.*, o.name AS organization_name, ${PUBLIC_ONLY_SQL} AS public_only, cu.name AS created_by_name FROM monitors m JOIN organizations o ON o.id = m.organization_id LEFT JOIN users cu ON cu.id = m.created_by`;
const CUSTOMER_DEFAULT_MONITORS = 5;

function canManage(actor, row) {
  if (isStaff(actor)) return true;
  return actor.role === "customer_admin" && row.organization_id === actor.organizationId && row.public_only === 1;
}

function loadMonitor(db, actor, id) {
  const s = scope(actor, null);
  const row = db.prepare(`${MONITOR_SELECT} WHERE m.id = ? AND ${s.sql}`).get(id, ...s.args);
  if (!row) throw new HttpError(404, "Not found.");
  return row;
}

function list({ db, actor, url }) {
  const { page, limit, offset } = pageParams(url);
  const s = scope(actor, url);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM monitors m WHERE ${s.sql}`).get(...s.args).n;
  const rows = db.prepare(`${MONITOR_SELECT} WHERE ${s.sql} ORDER BY o.name, m.name LIMIT ? OFFSET ?`).all(...s.args, limit, offset);
  return { items: rows.map((row) => mapMonitor(row, actor, uptime(db, row.id, 24))), page, pageSize: limit, total };
}

function get({ db, actor, params }) {
  const row = loadMonitor(db, actor, params.id);
  const checks = db.prepare("SELECT checked_at, ok, response_ms, status_code, error FROM monitor_checks WHERE monitor_id = ? ORDER BY id DESC LIMIT 100").all(row.id).map((c) => ({
    checkedAt: c.checked_at,
    ok: c.ok === 1,
    responseMs: c.response_ms,
    statusCode: c.status_code,
    error: isStaff(actor) ? c.error : (c.ok ? null : "Check failed"),
  }));
  const since = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  const byDay = Object.fromEntries(db.prepare(`
    SELECT substr(checked_at, 1, 10) AS day, COUNT(*) AS total, SUM(ok) AS up, AVG(CASE WHEN ok = 1 THEN response_ms END) AS avg_ms
    FROM monitor_checks WHERE monitor_id = ? AND checked_at >= ? GROUP BY day
  `).all(row.id, since).map((d) => [d.day, d]));
  const daily = Array.from({ length: 90 }, (_, i) => {
    const day = new Date(Date.parse(`${since}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    const d = byDay[day];
    return { day, checks: d?.total || 0, uptimePercent: d ? Math.round((d.up / d.total) * 10000) / 100 : null, avgResponseMs: d?.avg_ms ? Math.round(d.avg_ms) : null };
  });
  return { monitor: mapMonitor(row, actor), day: uptime(db, row.id, 24), week: uptime(db, row.id, 24 * 7), month: uptime(db, row.id, 24 * 30), quarter: uptime(db, row.id, 24 * 90), checks, daily };
}

async function customerFields(body, current = {}) {
  const pick = fieldPicker(body, current);
  const raw = body.target === undefined ? current.target : body.target;
  const target = await assertPublicUrl(assertMonitorTarget("http", raw));
  return {
    name: pick("name", "name", (v) => assertText(v, "Website name", 120)),
    type: "http",
    target,
    port: null,
    interval_seconds: pick("intervalSeconds", "interval_seconds", (v) => assertInt(v, "Check interval (seconds)", 300, 86400), 300),
    timeout_ms: current.timeout_ms ?? 10000,
    failure_threshold: current.failure_threshold ?? 2,
    expected_status: current.expected_status ?? "200-399",
    ssl_warning_days: current.ssl_warning_days ?? 14,
    customer_visible: 1,
    active: pick("active", "active", assertBool, 1),
  };
}

function fields(body, current = {}) {
  const pick = fieldPicker(body, current);
  const type = pick("type", "type", (v) => assertEnum(v, ["http", "tcp", "ping"], "monitor type"));
  const target = assertMonitorTarget(type, body.target === undefined ? current.target : body.target);
  if (!target) throw new HttpError(400, "Enter the address to monitor.");
  const port = type === "tcp" ? assertInt(body.port === undefined ? current.port : body.port, "Port", 1, 65535) : null;
  return {
    name: pick("name", "name", (v) => assertText(v, "Monitor name", 120)),
    type,
    target,
    port,
    interval_seconds: pick("intervalSeconds", "interval_seconds", (v) => assertInt(v, "Check interval (seconds)", 60, 86400), 300),
    timeout_ms: pick("timeoutMs", "timeout_ms", (v) => assertInt(v, "Timeout (ms)", 1000, 30000), 10000),
    failure_threshold: pick("failureThreshold", "failure_threshold", (v) => assertInt(v, "Failures before alert", 1, 10), 2),
    expected_status: pick("expectedStatus", "expected_status", (v) => {
      const text = String(v || "200-399").trim();
      if (!/^\d{3}(-\d{3})?(,\s*\d{3}(-\d{3})?)*$/.test(text)) throw new HttpError(400, "Expected status looks like 200-399 or 200,301.");
      return text;
    }, "200-399"),
    ssl_warning_days: pick("sslWarningDays", "ssl_warning_days", (v) => assertInt(v, "Certificate warning (days)", 1, 120), 14),
    customer_visible: pick("customerVisible", "customer_visible", assertBool, 1),
    active: pick("active", "active", assertBool, 1),
  };
}

async function create({ db, actor, body }) {
  const staff = isStaff(actor);
  if (!staff) {
    requireRole(actor, "customer_admin");
    requireOperationalOrg(db, actor);
    rateLimit(db, `monitor-create:${actor.id}`, 20, 60, "Too many websites added in the last hour. Try again later.");
  }
  const organizationId = scopeOrgId(actor, body.organizationId);
  const org = mustOrg(db, organizationId);
  const count = db.prepare("SELECT COUNT(*) AS n FROM monitors WHERE organization_id = ?").get(organizationId).n;
  if (staff && org.monitor_limit && org.subscription_status === "active" && count >= org.monitor_limit && actor.role !== "admin") {
    throw new HttpError(400, `This plan covers ${org.monitor_limit} monitors. An administrator can add more.`);
  }
  if (!staff) {
    const limit = org.monitor_limit || CUSTOMER_DEFAULT_MONITORS;
    if (count >= limit) throw new HttpError(400, `Your plan covers ${limit} monitored websites. Contact OSVIA to add more.`);
  }
  const f = staff ? fields(body) : await customerFields(body);
  const keys = Object.keys(f);
  const info = db.prepare(`INSERT INTO monitors (organization_id, ${keys.join(", ")}, created_by, created_at) VALUES (?, ${keys.map(() => "?").join(", ")}, ?, ?)`).run(organizationId, ...keys.map((k) => f[k]), actor.id, nowIso());
  audit(db, actor.id, "monitor.create", "monitor", info.lastInsertRowid, organizationId, { type: f.type, target: f.target }, actor.ip);
  if (!staff) {
    notifyUsers(db, staffIds(db), { title: `${org.name} added a website to monitor`, body: `${f.name}: ${f.target}`, kind: "monitor", link: `monitoring/${info.lastInsertRowid}`, email: false });
  }
  return reply(201, { monitor: mapMonitor(loadMonitor(db, actor, Number(info.lastInsertRowid)), actor) });
}

async function update({ db, actor, params, body }) {
  const row = loadMonitor(db, actor, params.id);
  if (!canManage(actor, row)) throw new HttpError(403, "OSVIA manages this monitor. Open a ticket to change it.");
  const f = row.public_only ? await customerFields(body, row) : fields(body, row);
  const keys = Object.keys(f);
  const reset = f.target !== row.target || f.type !== row.type || f.port !== row.port;
  db.prepare(`UPDATE monitors SET ${keys.map((k) => `${k} = ?`).join(", ")}${reset ? ", status = 'unknown', consecutive_failures = 0, ssl_expires_at = NULL" : ""} WHERE id = ?`).run(...keys.map((k) => f[k]), row.id);
  audit(db, actor.id, "monitor.update", "monitor", row.id, row.organization_id, { changes: changes(row, f, keys), reason: nullableText(body.reason, 300, "Reason") }, actor.ip);
  return { monitor: mapMonitor(loadMonitor(db, actor, row.id), actor) };
}

async function runNow({ db, actor, params }) {
  requireStaff(actor);
  const row = loadMonitor(db, actor, params.id);
  recordMonitorResult(db, row, await checkMonitor(row));
  return { monitor: mapMonitor(loadMonitor(db, actor, row.id), actor) };
}

function remove({ db, actor, params }) {
  const row = loadMonitor(db, actor, params.id);
  if (!canManage(actor, row)) throw new HttpError(403, "OSVIA manages this monitor. Open a ticket to change it.");
  const history = db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE monitor_id = ?").get(row.id).n;
  if (history) {
    db.prepare("UPDATE monitors SET active = 0 WHERE id = ?").run(row.id);
    audit(db, actor.id, "monitor.pause", "monitor", row.id, row.organization_id, { reason: "has incident history" }, actor.ip);
    return { ok: true, paused: true, message: "The monitor has incident history, so it was paused instead of deleted." };
  }
  transaction(db, () => {
    db.prepare("DELETE FROM monitor_checks WHERE monitor_id = ?").run(row.id);
    db.prepare("DELETE FROM monitors WHERE id = ?").run(row.id);
    audit(db, actor.id, "monitor.delete", "monitor", row.id, row.organization_id, null, actor.ip);
  });
  return { ok: true };
}

const INCIDENT_SELECT = `
  SELECT i.*, o.name AS organization_name, m.name AS monitor_name, d.name AS device_name
  FROM incidents i JOIN organizations o ON o.id = i.organization_id LEFT JOIN monitors m ON m.id = i.monitor_id LEFT JOIN devices d ON d.id = i.device_id
`;

function incidentScope(actor, url) {
  const where = [];
  const args = [];
  if (!isStaff(actor)) {
    where.push("i.organization_id = ?", "i.customer_visible = 1");
    args.push(actor.organizationId);
    if (actor.role === "customer_user") {
      where.push("(i.device_id IS NULL OR i.device_id IN (SELECT id FROM devices WHERE assigned_user_id = ?))");
      args.push(actor.id);
    }
  } else if (url?.searchParams.get("organizationId")) {
    where.push("i.organization_id = ?");
    args.push(scopeOrgId(actor, url.searchParams.get("organizationId")));
  }
  if (url?.searchParams.get("status")) {
    where.push("i.status = ?");
    args.push(assertEnum(url.searchParams.get("status"), ["open", "resolved"], "status"));
  }
  return { sql: where.length ? where.join(" AND ") : "1 = 1", args };
}

function mapIncident(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    title: row.title,
    severity: row.severity,
    status: row.status,
    source: row.monitor_id ? `Monitor: ${row.monitor_name}` : row.device_id ? `Device: ${row.device_name}` : "Reported by OSVIA",
    monitorId: row.monitor_id,
    deviceId: row.device_id,
    customerVisible: row.customer_visible === 1,
    summary: row.summary || "",
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    durationMinutes: Math.round(((row.resolved_at ? Date.parse(row.resolved_at) : Date.now()) - Date.parse(row.started_at)) / 60000),
  };
}

function listIncidents({ db, actor, url }) {
  const { page, limit, offset } = pageParams(url);
  const s = incidentScope(actor, url);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM incidents i WHERE ${s.sql}`).get(...s.args).n;
  const items = db.prepare(`${INCIDENT_SELECT} WHERE ${s.sql} ORDER BY i.status = 'open' DESC, i.started_at DESC LIMIT ? OFFSET ?`).all(...s.args, limit, offset).map(mapIncident);
  return { items, page, pageSize: limit, total };
}

function getIncident({ db, actor, params }) {
  const s = incidentScope(actor, null);
  const row = db.prepare(`${INCIDENT_SELECT} WHERE i.id = ? AND ${s.sql}`).get(params.id, ...s.args);
  if (!row) throw new HttpError(404, "Not found.");
  return { incident: mapIncident(row) };
}

function createIncident({ db, actor, body }) {
  requireStaff(actor);
  const organizationId = scopeOrgId(actor, body.organizationId);
  mustOrg(db, organizationId);
  const title = assertText(body.title, "Title", 160);
  const severity = assertEnum(body.severity || "minor", ["minor", "major", "critical"], "severity");
  const visible = body.customerVisible === undefined ? 1 : assertBool(body.customerVisible);
  const id = transaction(db, () => {
    const info = db.prepare(`
      INSERT INTO incidents (organization_id, title, severity, status, customer_visible, summary, started_at, created_by, last_notified_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)
    `).run(organizationId, title, severity, visible, nullableText(body.summary, 4000, "Summary"), body.startedAt ? assertDateTime(body.startedAt, "Start") : nowIso(), actor.id, nowIso());
    const incidentId = Number(info.lastInsertRowid);
    audit(db, actor.id, "incident.create", "incident", incidentId, organizationId, { severity }, actor.ip);
    const recipients = staffIds(db);
    if (visible) recipients.push(...customerAdminIds(db, organizationId));
    notifyUsers(db, recipients, { title: `Incident: ${title}`, body: `Severity ${severity}.`, kind: "incident", link: `incidents/${incidentId}`, marker: `incident-open:${incidentId}` });
    return incidentId;
  });
  return reply(201, getIncident({ db, actor, params: { id } }));
}

function updateIncident({ db, actor, params, body }) {
  requireStaff(actor);
  const row = db.prepare("SELECT * FROM incidents WHERE id = ?").get(params.id);
  if (!row) throw new HttpError(404, "Not found.");
  const summary = body.summary === undefined ? row.summary : nullableText(body.summary, 4000, "Summary");
  const severity = body.severity === undefined ? row.severity : assertEnum(body.severity, ["minor", "major", "critical"], "severity");
  const visible = body.customerVisible === undefined ? row.customer_visible : assertBool(body.customerVisible);
  const resolve = body.status === "resolved" && row.status === "open";
  transaction(db, () => {
    db.prepare("UPDATE incidents SET summary = ?, severity = ?, customer_visible = ?, status = ?, resolved_at = ? WHERE id = ?").run(
      summary, severity, visible, resolve ? "resolved" : row.status, resolve ? nowIso() : row.resolved_at, row.id,
    );
    audit(db, actor.id, resolve ? "incident.resolve" : "incident.update", "incident", row.id, row.organization_id, {
      changes: changes(row, { ...row, summary, severity, customer_visible: visible, status: resolve ? "resolved" : row.status }, ["status", "severity", "customer_visible", "summary"]),
    }, actor.ip);
    if (resolve) {
      const recipients = staffIds(db);
      if (visible) recipients.push(...customerAdminIds(db, row.organization_id));
      notifyUsers(db, recipients, { title: `Resolved: ${row.title}`, body: summary || "OSVIA marked this incident resolved.", kind: "incident", link: `incidents/${row.id}`, marker: `incident-resolved:${row.id}` });
    }
  });
  return getIncident({ db, actor, params });
}

function mapWindow(row) {
  return { id: row.id, organizationId: row.organization_id, organizationName: row.organization_name || "All organizations", title: row.title, startsAt: row.starts_at, endsAt: row.ends_at, active: row.starts_at <= nowIso() && row.ends_at > nowIso() };
}

function listWindows({ db, actor, url }) {
  const upcoming = url.searchParams.get("all") !== "1";
  const where = [];
  const args = [];
  if (!isStaff(actor)) {
    where.push("(w.organization_id IS NULL OR w.organization_id = ?)");
    args.push(actor.organizationId);
  }
  if (upcoming) where.push("w.ends_at > ?"), args.push(nowIso());
  const rows = db.prepare(`
    SELECT w.*, o.name AS organization_name FROM maintenance_windows w LEFT JOIN organizations o ON o.id = w.organization_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY w.starts_at DESC LIMIT 200
  `).all(...args);
  return { items: rows.map(mapWindow) };
}

function createWindow({ db, actor, body }) {
  requireStaff(actor);
  const organizationId = body.organizationId ? scopeOrgId(actor, body.organizationId) : null;
  if (organizationId) mustOrg(db, organizationId);
  const startsAt = assertDateTime(body.startsAt, "Start");
  const endsAt = assertDateTime(body.endsAt, "End");
  if (endsAt <= startsAt) throw new HttpError(400, "The window must end after it starts.");
  if (Date.parse(endsAt) - Date.parse(startsAt) > 7 * 86400000) throw new HttpError(400, "A maintenance window can last at most 7 days.");
  const info = db.prepare("INSERT INTO maintenance_windows (organization_id, title, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    organizationId, assertText(body.title, "Title", 160), startsAt, endsAt, actor.id, nowIso(),
  );
  audit(db, actor.id, "maintenance_window.create", "maintenance_window", info.lastInsertRowid, organizationId, { startsAt, endsAt }, actor.ip);
  return reply(201, { window: mapWindow(db.prepare("SELECT w.*, o.name AS organization_name FROM maintenance_windows w LEFT JOIN organizations o ON o.id = w.organization_id WHERE w.id = ?").get(info.lastInsertRowid)) });
}

function deleteWindow({ db, actor, params }) {
  requireStaff(actor);
  const row = db.prepare("SELECT * FROM maintenance_windows WHERE id = ?").get(params.id);
  if (!row) throw new HttpError(404, "Not found.");
  if (row.starts_at <= nowIso()) {
    db.prepare("UPDATE maintenance_windows SET ends_at = ? WHERE id = ?").run(new Date(Math.max(Date.now(), Date.parse(row.starts_at) + 1000)).toISOString(), row.id);
  } else {
    db.prepare("DELETE FROM maintenance_windows WHERE id = ?").run(row.id);
  }
  audit(db, actor.id, "maintenance_window.end", "maintenance_window", row.id, row.organization_id, null, actor.ip);
  return { ok: true };
}

export const routes = [
  ["GET", "/api/monitors", list],
  ["POST", "/api/monitors", create],
  ["GET", "/api/monitors/:id", get],
  ["PATCH", "/api/monitors/:id", update],
  ["DELETE", "/api/monitors/:id", remove],
  ["POST", "/api/monitors/:id/run", runNow],
  ["GET", "/api/incidents", listIncidents],
  ["POST", "/api/incidents", createIncident],
  ["GET", "/api/incidents/:id", getIncident],
  ["PATCH", "/api/incidents/:id", updateIncident],
  ["GET", "/api/maintenance-windows", listWindows],
  ["POST", "/api/maintenance-windows", createWindow],
  ["DELETE", "/api/maintenance-windows/:id", deleteWindow],
];
