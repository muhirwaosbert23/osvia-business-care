import { isStaff, requireMfa, requireOperationalOrg, requireRole, requireStaff, scopeOrgId } from "../auth.js";
import { ASSET_TYPES, CONDITIONS, OPERATIONAL_STATUSES } from "../constants.js";
import { streamCsv } from "../csv.js";
import { audit, transaction } from "../db.js";
import { HttpError } from "../errors.js";
import { reply, startStream } from "../http.js";
import { remoteLaunchUrl } from "../meshcentral.js";
import { applyDeviceCheck } from "../monitoring.js";
import { customerAdminIds, notifyUsers } from "../notify.js";
import { assertHost } from "../probe.js";
import { assertEnum, assertId, assertText, likePattern, nowIso, nullableText, optionalDate, optionalInt, pageParams } from "../validate.js";

const DEVICE_SELECT = `
  SELECT d.*, o.name AS organization_name, o.status AS organization_status, u.name AS assigned_user_name
  FROM devices d JOIN organizations o ON o.id = d.organization_id LEFT JOIN users u ON u.id = d.assigned_user_id
`;

function mapDevice(row, actor) {
  const data = {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    name: row.name,
    assetType: row.asset_type,
    operatingSystem: row.operating_system || "",
    manufacturer: row.manufacturer || "",
    model: row.model || "",
    serialNumber: row.serial_number || "",
    assetTag: row.asset_tag || "",
    assignedUserId: row.assigned_user_id,
    assignedUserName: row.assigned_user_name || "",
    installDate: row.install_date,
    warrantyExpiry: row.warranty_expiry,
    condition: row.condition,
    operationalStatus: row.operational_status,
    hardwareNotes: row.hardware_notes || "",
    notes: row.notes || "",
    source: row.source,
    reachability: row.reachability,
    lastChecked: row.last_checked,
    lastConnection: row.last_connection,
    consentAt: row.consent_at,
    managed: Boolean(row.mesh_node_id),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
  if (isStaff(actor)) {
    data.address = row.address || "";
    data.checkPort = row.check_port;
    data.meshNodeId = row.mesh_node_id || "";
    data.meshSyncedAt = row.mesh_synced_at;
  }
  return data;
}

function scope(actor) {
  if (isStaff(actor)) return { sql: "1 = 1", args: [] };
  if (actor.role === "customer_admin") return { sql: "d.organization_id = ?", args: [actor.organizationId] };
  return { sql: "d.organization_id = ? AND d.assigned_user_id = ?", args: [actor.organizationId, actor.id] };
}

function loadDevice(db, actor, id) {
  const s = scope(actor);
  const row = db.prepare(`${DEVICE_SELECT} WHERE d.id = ? AND ${s.sql}`).get(id, ...s.args);
  if (!row) throw new HttpError(404, "Not found.");
  return row;
}

function filters(actor, url) {
  const s = scope(actor);
  const where = [s.sql];
  const args = [...s.args];
  const p = url.searchParams;
  if (p.get("archived") === "1") where.push("d.archived_at IS NOT NULL");
  else where.push("d.archived_at IS NULL");
  if (isStaff(actor) && p.get("organizationId")) where.push("d.organization_id = ?"), args.push(scopeOrgId(actor, p.get("organizationId")));
  if (p.get("reachability")) where.push("d.reachability = ?"), args.push(assertEnum(p.get("reachability"), ["online", "offline", "unknown"], "status"));
  if (p.get("assetType")) where.push("d.asset_type = ?"), args.push(assertEnum(p.get("assetType"), ASSET_TYPES, "asset type"));
  if (p.get("warranty") === "expiring") where.push("d.warranty_expiry IS NOT NULL AND d.warranty_expiry <= date('now', '+60 days')");
  const q = String(p.get("q") || "").trim().slice(0, 100);
  if (q) {
    where.push("(d.name LIKE ? ESCAPE '\\' OR d.serial_number LIKE ? ESCAPE '\\' OR d.asset_tag LIKE ? ESCAPE '\\' OR d.model LIKE ? ESCAPE '\\')");
    args.push(likePattern(q), likePattern(q), likePattern(q), likePattern(q));
  }
  return { clause: `WHERE ${where.join(" AND ")}`, args };
}

function list({ db, actor, url }) {
  const { page, limit, offset, orderBy } = pageParams(url, { name: "d.name", created: "d.created_at", status: "d.reachability", warranty: "d.warranty_expiry", checked: "d.last_checked" }, "name");
  const { clause, args } = filters(actor, url);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM devices d ${clause}`).get(...args).n;
  const rows = db.prepare(`${DEVICE_SELECT} ${clause} ORDER BY ${orderBy}, d.id LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { items: rows.map((row) => mapDevice(row, actor)), page, pageSize: limit, total };
}

function exportCsv({ db, actor, url, res }) {
  const { clause, args } = filters(actor, url);
  audit(db, actor.id, "device.export", "device", null, isStaff(actor) ? null : actor.organizationId, null, actor.ip);
  startStream(res, { type: "text/csv; charset=utf-8", filename: `osvia-assets-${nowIso().slice(0, 10)}.csv` });
  streamCsv(
    res,
    ["Organization", "Name", "Type", "Manufacturer", "Model", "Serial", "Asset tag", "Assigned to", "OS", "Condition", "Status", "Reachability", "Last checked", "Install date", "Warranty expiry", "Consent"],
    (limit, offset) => db.prepare(`${DEVICE_SELECT} ${clause} ORDER BY d.organization_id, d.name LIMIT ? OFFSET ?`).all(...args, limit, offset),
    (d) => [d.organization_name, d.name, d.asset_type, d.manufacturer, d.model, d.serial_number, d.asset_tag, d.assigned_user_name, d.operating_system, d.condition, d.operational_status, d.reachability, d.last_checked, d.install_date, d.warranty_expiry, d.consent_at ? "yes" : "no"],
  );
}

function assignedUser(db, organizationId, value) {
  if (value === null || value === undefined || value === "") return null;
  const id = assertId(value, "Assigned user");
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND organization_id = ?").get(id, organizationId)) throw new HttpError(400, "Assign the device to a user of the same organization.");
  return id;
}

const ASSET_FIELDS = [
  ["name", "name", (v) => assertText(v, "Device name", 120)],
  ["assetType", "asset_type", (v) => assertEnum(v, ASSET_TYPES, "asset type")],
  ["operatingSystem", "operating_system", (v) => nullableText(v, 120, "Operating system")],
  ["manufacturer", "manufacturer", (v) => nullableText(v, 120, "Manufacturer")],
  ["model", "model", (v) => nullableText(v, 120, "Model")],
  ["serialNumber", "serial_number", (v) => nullableText(v, 120, "Serial number")],
  ["assetTag", "asset_tag", (v) => nullableText(v, 60, "Asset tag")],
  ["installDate", "install_date", (v) => optionalDate(v, "Install date")],
  ["warrantyExpiry", "warranty_expiry", (v) => optionalDate(v, "Warranty expiry")],
  ["condition", "condition", (v) => assertEnum(v, CONDITIONS, "condition")],
  ["operationalStatus", "operational_status", (v) => assertEnum(v, OPERATIONAL_STATUSES, "operational status")],
  ["hardwareNotes", "hardware_notes", (v) => nullableText(v, 2000, "Hardware notes")],
  ["notes", "notes", (v) => nullableText(v, 2000, "Notes")],
];

function assetFields(body, current = {}) {
  return Object.fromEntries(ASSET_FIELDS.map(([key, column, fn]) => [column, body[key] === undefined ? (current[column] ?? null) : fn(body[key])]));
}

function networkFields(actor, body, current = {}) {
  const wantsChange = body.address !== undefined || body.checkPort !== undefined;
  if (!wantsChange) return { address: current.address ?? null, check_port: current.check_port ?? null };
  if (!isStaff(actor)) throw new HttpError(403, "Only OSVIA staff can set the address used for status checks.");
  const address = body.address === undefined ? current.address : (String(body.address || "").trim() ? assertHost(body.address) : null);
  const checkPort = body.checkPort === undefined ? current.check_port : optionalInt(body.checkPort, "Check port", 1, 65535);
  return { address, check_port: address ? checkPort : null };
}

function create({ db, actor, body }) {
  if (!isStaff(actor)) requireRole(actor, "customer_admin");
  requireOperationalOrg(db, actor);
  const organizationId = scopeOrgId(actor, body.organizationId);
  const org = db.prepare("SELECT o.status, o.subscription_status, p.device_limit FROM organizations o LEFT JOIN service_plans p ON p.id = o.plan_id WHERE o.id = ?").get(organizationId);
  if (!org) throw new HttpError(400, "Choose an organization.");
  if (!isStaff(actor) && org.device_limit && org.subscription_status === "active") {
    const count = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE organization_id = ? AND archived_at IS NULL").get(organizationId).n;
    if (count >= org.device_limit) throw new HttpError(400, `Your plan covers ${org.device_limit} devices. Contact OSVIA to upgrade.`);
  }
  const fields = { ...assetFields({ condition: "unknown", operationalStatus: "in_service", assetType: "computer", ...body }), ...networkFields(actor, body) };
  const assigned = assignedUser(db, organizationId, body.assignedUserId);
  const now = nowIso();
  const id = transaction(db, () => {
    const keys = Object.keys(fields);
    const info = db.prepare(`
      INSERT INTO devices (organization_id, ${keys.join(", ")}, assigned_user_id, source, created_at, updated_at)
      VALUES (?, ${keys.map(() => "?").join(", ")}, ?, 'manual', ?, ?)
    `).run(organizationId, ...keys.map((k) => fields[k]), assigned, now, now);
    const deviceId = Number(info.lastInsertRowid);
    if (assigned) db.prepare("INSERT INTO device_assignments (device_id, user_id, assigned_by, note, created_at) VALUES (?, ?, ?, 'Initial assignment', ?)").run(deviceId, assigned, actor.id, now);
    audit(db, actor.id, "device.create", "device", deviceId, organizationId, null, actor.ip);
    return deviceId;
  });
  return reply(201, { device: mapDevice(loadDevice(db, actor, id), actor) });
}

function get({ db, actor, params }) {
  const row = loadDevice(db, actor, params.id);
  const assignments = db.prepare(`
    SELECT a.*, u.name AS user_name, b.name AS by_name FROM device_assignments a LEFT JOIN users u ON u.id = a.user_id JOIN users b ON b.id = a.assigned_by
    WHERE a.device_id = ? ORDER BY a.id DESC LIMIT 50
  `).all(row.id).map((a) => ({ id: a.id, userName: a.user_name || "Unassigned", byName: a.by_name, note: a.note || "", createdAt: a.created_at }));
  const maintenance = db.prepare(`
    SELECT m.*, u.name AS technician FROM maintenance_records m JOIN users u ON u.id = m.technician_id WHERE m.device_id = ? ORDER BY m.performed_at DESC LIMIT 50
  `).all(row.id).map((m) => ({ id: m.id, summary: m.summary, performedAt: m.performed_at, technician: m.technician }));
  const tickets = db.prepare(`
    SELECT id, number, title, status, created_at FROM tickets WHERE device_id = ? ${actor.role === "customer_user" ? "AND created_by = ?" : ""} ORDER BY id DESC LIMIT 20
  `).all(...(actor.role === "customer_user" ? [row.id, actor.id] : [row.id])).map((t) => ({ id: t.id, number: t.number, title: t.title, status: t.status, createdAt: t.created_at }));
  const remote = db.prepare(`
    SELECT r.*, u.name AS technician FROM remote_sessions r JOIN users u ON u.id = r.technician_id WHERE r.device_id = ? ORDER BY r.id DESC LIMIT 50
  `).all(row.id).map((r) => ({ id: r.id, technician: r.technician, mode: r.mode, reason: r.reason, ticketId: r.ticket_id, launchedAt: r.launched_at }));
  return { device: mapDevice(row, actor), assignments, maintenance, tickets, remoteSessions: remote };
}

function update({ db, actor, params, body }) {
  if (!isStaff(actor)) requireRole(actor, "customer_admin");
  const row = loadDevice(db, actor, params.id);
  if (row.archived_at && body.restore !== true) throw new HttpError(400, "Restore this device before editing it.");
  const fields = { ...assetFields(body, row), ...networkFields(actor, body, row) };
  const now = nowIso();
  transaction(db, () => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE devices SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now, row.id);
    if (body.restore === true && row.archived_at) db.prepare("UPDATE devices SET archived_at = NULL WHERE id = ?").run(row.id);
    if (body.assignedUserId !== undefined) {
      const assigned = assignedUser(db, row.organization_id, body.assignedUserId);
      if (assigned !== row.assigned_user_id) {
        db.prepare("UPDATE devices SET assigned_user_id = ? WHERE id = ?").run(assigned, row.id);
        db.prepare("INSERT INTO device_assignments (device_id, user_id, assigned_by, note, created_at) VALUES (?, ?, ?, ?, ?)").run(row.id, assigned, actor.id, nullableText(body.assignmentNote, 300, "Assignment note"), now);
      }
    }
    if (fields.address !== row.address) db.prepare("UPDATE devices SET reachability = 'unknown', last_checked = NULL WHERE id = ?").run(row.id);
    audit(db, actor.id, "device.update", "device", row.id, row.organization_id, null, actor.ip);
  });
  return { device: mapDevice(loadDevice(db, actor, row.id), actor) };
}

function archive({ db, actor, params }) {
  if (!isStaff(actor)) requireRole(actor, "customer_admin");
  const row = loadDevice(db, actor, params.id);
  if (row.archived_at) throw new HttpError(400, "This device is already archived.");
  db.prepare("UPDATE devices SET archived_at = ?, operational_status = 'retired', updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), row.id);
  audit(db, actor.id, "device.archive", "device", row.id, row.organization_id, null, actor.ip);
  return { device: mapDevice(loadDevice(db, actor, row.id), actor) };
}

function consent(grant) {
  return ({ db, actor, params, body }) => {
    requireRole(actor, "customer_admin");
    requireOperationalOrg(db, actor);
    const row = loadDevice(db, actor, params.id);
    if (grant) {
      if (body.confirm !== true) throw new HttpError(400, "Confirm that OSVIA may provide remote support on this device.");
      db.prepare("UPDATE devices SET consent_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), row.id);
    } else {
      db.prepare("UPDATE devices SET consent_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), row.id);
    }
    audit(db, actor.id, grant ? "device.consent" : "device.consent_revoke", "device", row.id, row.organization_id, null, actor.ip);
    return { device: mapDevice(loadDevice(db, actor, row.id), actor) };
  };
}

async function checkNow({ db, actor, params }) {
  requireStaff(actor);
  const row = loadDevice(db, actor, params.id);
  if (row.source === "meshcentral") throw new HttpError(400, "This device's status comes from MeshCentral. Run a MeshCentral sync instead.");
  if (!row.address) throw new HttpError(400, "Add an IP address or host name before checking this device.");
  await applyDeviceCheck(db, row.id);
  return { device: mapDevice(loadDevice(db, actor, row.id), actor) };
}

function remote({ db, actor, params, body }) {
  requireStaff(actor);
  requireMfa(actor);
  const row = loadDevice(db, actor, params.id);
  if (row.organization_status !== "active") throw new HttpError(403, "Remote support is unavailable while the organization is not active.");
  if (!row.mesh_node_id) throw new HttpError(400, "This device is not linked to a MeshCentral agent.");
  if (!row.consent_at) throw new HttpError(403, "The customer has not recorded remote-support consent for this device.");
  const mode = assertEnum(body.mode || "desktop", ["desktop", "terminal", "files", "general"], "session type");
  const reason = assertText(body.reason, "Reason", 300);
  let ticketId = null;
  if (body.ticketId) {
    ticketId = assertId(body.ticketId, "Ticket");
    if (!db.prepare("SELECT 1 FROM tickets WHERE id = ? AND organization_id = ?").get(ticketId, row.organization_id)) throw new HttpError(400, "That ticket belongs to another organization.");
  }
  const url = remoteLaunchUrl(row, mode);
  transaction(db, () => {
    const info = db.prepare("INSERT INTO remote_sessions (device_id, organization_id, technician_id, ticket_id, mode, reason, launched_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(row.id, row.organization_id, actor.id, ticketId, mode, reason, nowIso());
    audit(db, actor.id, "remote.launch", "device", row.id, row.organization_id, { mode, ticketId, session: Number(info.lastInsertRowid) }, actor.ip);
    notifyUsers(db, customerAdminIds(db, row.organization_id), {
      title: `OSVIA opened a remote ${mode} session`,
      body: `${actor.name} started a remote ${mode} session on ${row.name}. Reason: ${reason}`,
      kind: "remote",
      link: `devices/${row.id}`,
    });
  });
  return { url, notice: "MeshCentral asks you to sign in with your own MeshCentral account. The customer can see the session according to their MeshCentral consent settings." };
}

export const routes = [
  ["GET", "/api/devices", list],
  ["POST", "/api/devices", create],
  ["GET", "/api/devices/export.csv", exportCsv],
  ["GET", "/api/devices/:id", get],
  ["PATCH", "/api/devices/:id", update],
  ["POST", "/api/devices/:id/archive", archive],
  ["POST", "/api/devices/:id/consent", consent(true)],
  ["POST", "/api/devices/:id/consent/revoke", consent(false)],
  ["POST", "/api/devices/:id/check", checkNow],
  ["POST", "/api/devices/:id/remote", remote],
];
