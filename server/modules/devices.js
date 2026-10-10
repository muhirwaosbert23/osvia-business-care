import { isStaff, rateLimit, requireMfa, requireOperationalOrg, requireRole, requireStaff, scopeOrgId } from "../auth.js";
import { ASSET_TYPES, CONDITIONS, OPERATIONAL_STATUSES } from "../constants.js";
import { streamCsv } from "../csv.js";
import { audit, changes, transaction } from "../db.js";
import { HttpError } from "../errors.js";
import { reply, startStream } from "../http.js";
import { geocodePlace, lookupPublicIp } from "../geo.js";
import { locationHistory, mapLocation, refreshDeviceLocations, saveLocation } from "../location.js";
import { meshConfig, meshConfigured, remoteLaunchUrl, syncDevices } from "../meshcentral.js";
import { applyDeviceCheck } from "../monitoring.js";
import { diagnoseHost, packTroubleshoot } from "../troubleshoot.js";
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
    data.hasLocation = row.last_lat != null;
    data.location = mapLocation(row);
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

export function loadDevice(db, actor, id) {
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
  return { address, check_port: address ? (checkPort ?? null) : null };
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
    if (isStaff(actor) && body.meshNodeId) {
      const raw = String(body.meshNodeId || "").trim();
      if (raw && !/^(node\/)?[A-Za-z0-9/@$_.-]+$/.test(raw)) throw new HttpError(400, "That MeshCentral node id has unexpected characters.");
      const meshNodeId = raw ? (raw.startsWith("node/") ? raw : `node//${raw}`) : null;
      if (meshNodeId) db.prepare("UPDATE devices SET mesh_node_id = ?, source = 'meshcentral', management_status = 'agent_installed' WHERE id = ?").run(meshNodeId, deviceId);
    }
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
  const findings = isStaff(actor)
    ? db.prepare(`
        SELECT f.*, u.name AS actor_name FROM device_findings f JOIN users u ON u.id = f.created_by
        WHERE f.device_id = ? ORDER BY f.id DESC LIMIT 40
      `).all(row.id).map((f) => ({ id: f.id, kind: f.kind, body: f.body, actorName: f.actor_name, at: f.created_at }))
    : [];
  return {
    device: mapDevice(row, actor),
    assignments,
    maintenance,
    tickets,
    remoteSessions: remote,
    findings,
    troubleshoot: isStaff(actor) ? packTroubleshoot(row) : null,
  };
}

const DAY_MS = 86400000;

// Time is "known" only between a recorded status change and the device's most recent real check.
export function availability(events, { from, to, lastChecked, days }) {
  const knownUntil = lastChecked ? Math.min(to, Date.parse(lastChecked)) : from;
  const daily = Array.from({ length: days }, (_, i) => ({ day: new Date(from + i * DAY_MS).toISOString().slice(0, 10), onlineMs: 0, knownMs: 0 }));
  let onlineMs = 0;
  let knownMs = 0;
  events.forEach((event, index) => {
    const start = Math.max(from, Date.parse(event.created_at));
    const end = Math.min(knownUntil, index + 1 < events.length ? Date.parse(events[index + 1].created_at) : knownUntil);
    if (end <= start) return;
    knownMs += end - start;
    if (event.status === "online") onlineMs += end - start;
    for (let cursor = start; cursor < end;) {
      const dayIndex = Math.floor((cursor - from) / DAY_MS);
      const dayEnd = Math.min(end, from + (dayIndex + 1) * DAY_MS);
      if (daily[dayIndex]) {
        daily[dayIndex].knownMs += dayEnd - cursor;
        if (event.status === "online") daily[dayIndex].onlineMs += dayEnd - cursor;
      }
      cursor = dayEnd;
    }
  });
  const pct = (online, known) => (known > 0 ? Math.round((online / known) * 10000) / 100 : null);
  return {
    uptimePercent: pct(onlineMs, knownMs),
    coveragePercent: Math.round((knownMs / (to - from)) * 1000) / 10,
    daily: daily.map((d) => ({ day: d.day, uptimePercent: pct(d.onlineMs, d.knownMs), coveredHours: Math.round(d.knownMs / 360000) / 10 })),
  };
}

function availabilityRoute({ db, actor, params, url }) {
  const row = loadDevice(db, actor, params.id);
  const days = Number(url.searchParams.get("days")) === 90 ? 90 : Number(url.searchParams.get("days")) === 7 ? 7 : 30;
  const to = Date.now();
  const from = to - days * DAY_MS;
  const fromIso = new Date(from).toISOString();
  const before = db.prepare("SELECT * FROM device_status_events WHERE device_id = ? AND created_at < ? ORDER BY id DESC LIMIT 1").get(row.id, fromIso);
  const inside = db.prepare("SELECT * FROM device_status_events WHERE device_id = ? AND created_at >= ? ORDER BY id").all(row.id, fromIso);
  const events = before ? [before, ...inside] : inside;
  const recent = db.prepare("SELECT * FROM device_status_events WHERE device_id = ? ORDER BY id DESC LIMIT 50").all(row.id);
  return {
    days,
    source: row.source === "meshcentral" ? "meshcentral" : row.address ? "network_check" : "none",
    lastChecked: row.last_checked,
    ...availability(events, { from, to, lastChecked: row.last_checked, days }),
    changes: recent.map((e, i) => ({
      status: e.status,
      previousStatus: e.previous_status,
      source: e.source,
      at: e.created_at,
      lastedMinutes: i === 0 ? null : Math.round((Date.parse(recent[i - 1].created_at) - Date.parse(e.created_at)) / 60000),
    })),
  };
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
    if (body.meshNodeId !== undefined) {
      if (!isStaff(actor)) throw new HttpError(403, "Only OSVIA staff can link a MeshCentral agent.");
      const raw = String(body.meshNodeId || "").trim();
      if (raw && !/^(node\/)?[A-Za-z0-9/@$_.-]+$/.test(raw)) throw new HttpError(400, "That MeshCentral node id has unexpected characters.");
      const meshNodeId = raw ? (raw.startsWith("node/") ? raw : `node//${raw}`) : null;
      db.prepare("UPDATE devices SET mesh_node_id = ?, source = CASE WHEN ? IS NOT NULL THEN 'meshcentral' ELSE source END, management_status = CASE WHEN ? IS NOT NULL THEN 'agent_installed' ELSE management_status END WHERE id = ?").run(meshNodeId, meshNodeId, meshNodeId, row.id);
    }
    if (fields.address !== row.address) db.prepare("UPDATE devices SET reachability = 'unknown', last_checked = NULL WHERE id = ?").run(row.id);
    const after = db.prepare("SELECT * FROM devices WHERE id = ?").get(row.id);
    audit(db, actor.id, body.restore === true && row.archived_at ? "device.restore" : "device.update", "device", row.id, row.organization_id, {
      changes: changes(row, after, [...ASSET_FIELDS.map(([, column]) => column), "address", "check_port", "assigned_user_id", "mesh_node_id"]),
      reason: nullableText(body.reason ?? body.assignmentNote, 300, "Reason"),
    }, actor.ip);
  });
  return { device: mapDevice(loadDevice(db, actor, row.id), actor) };
}

function archive({ db, actor, params, body }) {
  if (!isStaff(actor)) requireRole(actor, "customer_admin");
  const row = loadDevice(db, actor, params.id);
  if (row.archived_at) throw new HttpError(400, "This device is already archived.");
  const reason = assertText(body?.reason, "Reason for archiving", 300);
  db.prepare("UPDATE devices SET archived_at = ?, operational_status = 'retired', updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), row.id);
  audit(db, actor.id, "device.archive", "device", row.id, row.organization_id, { reason }, actor.ip);
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
    audit(db, actor.id, grant ? "device.consent" : "device.consent_revoke", "device", row.id, row.organization_id, { reason: nullableText(body?.reason, 300, "Reason") }, actor.ip);
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
    audit(db, actor.id, "remote.launch", "device", row.id, row.organization_id, { mode, ticketId, session: Number(info.lastInsertRowid), reason }, actor.ip);
    notifyUsers(db, customerAdminIds(db, row.organization_id), {
      title: `OSVIA opened a remote ${mode} session`,
      body: `${actor.name} started a remote ${mode} session on ${row.name}. Reason: ${reason}`,
      kind: "remote",
      link: `devices/${row.id}`,
    });
  });
  return { url, notice: "MeshCentral asks you to sign in with your own MeshCentral account. The customer can see the session according to their MeshCentral consent settings." };
}

function getLocation({ db, actor, params }) {
  requireStaff(actor);
  const row = loadDevice(db, actor, params.id);
  return { location: mapLocation(row), ...locationHistory(db, row.id) };
}

function setLocation({ db, actor, params, body }) {
  requireStaff(actor);
  const row = loadDevice(db, actor, params.id);
  const source = assertEnum(body.source || "manual", ["manual", "gps"], "location source");
  const location = saveLocation(db, row, {
    lat: body.lat,
    lng: body.lng,
    source,
    label: nullableText(body.label, 200, "Place name"),
    accuracyM: body.accuracyM == null || body.accuracyM === "" ? 30 : optionalInt(body.accuracyM, "Accuracy", 1, 50000),
    actorId: actor.id,
  });
  audit(db, actor.id, "device.locate", "device", row.id, row.organization_id, { source, label: location.label }, actor.ip);
  return { location, device: mapDevice(loadDevice(db, actor, row.id), actor) };
}

async function locateDevice({ db, actor, params, body, services }) {
  requireStaff(actor);
  rateLimit(db, `locate:${actor.id}`, 20, 60, "Too many map lookups in the last hour. Try again later.");
  const row = loadDevice(db, actor, params.id);
  const fetchImpl = services?.lookupFetch || fetch;
  let found;
  if (body.place) found = await geocodePlace(body.place, fetchImpl);
  else {
    const target = String(body.ip || row.address || "").trim();
    if (!target) throw new HttpError(400, "Add a public IP or host name on the device, or search for a place.");
    found = await lookupPublicIp(target, fetchImpl);
  }
  const location = saveLocation(db, row, { ...found, actorId: actor.id });
  audit(db, actor.id, "device.locate", "device", row.id, row.organization_id, { source: found.source, label: found.label }, actor.ip);
  return { location, device: mapDevice(loadDevice(db, actor, row.id), actor), notice: found.source === "ip" ? "This is the public-internet area for that address, not the room the computer sits in." : null };
}

function mapRow(row) {
  return {
    id: row.id,
    name: row.name,
    organizationName: row.organization_name,
    reachability: row.reachability,
    source: row.source,
    lastSeenIp: row.last_seen_ip || "",
    address: row.address || "",
    location: mapLocation(row),
  };
}

function fleetMap({ db, actor, url }) {
  requireStaff(actor);
  const orgId = url.searchParams.get("organizationId");
  const where = orgId ? "d.organization_id = ? AND d.archived_at IS NULL" : "d.archived_at IS NULL";
  const args = orgId ? [scopeOrgId(actor, orgId)] : [];
  const rows = db.prepare(`
    SELECT d.id, d.name, d.source, d.address, d.last_seen_ip, d.last_lat, d.last_lng, d.last_location_at, d.last_location_source,
           d.last_location_label, d.last_location_accuracy, d.reachability, o.name AS organization_name
    FROM devices d JOIN organizations o ON o.id = d.organization_id
    WHERE ${where} ORDER BY o.name, d.name LIMIT 300
  `).all(...args).map(mapRow);
  const items = rows.filter((row) => row.location);
  const missing = rows.filter((row) => !row.location);
  return { items, missing, located: items.length, total: rows.length };
}

async function refreshFleet({ db, actor, services }) {
  requireStaff(actor);
  rateLimit(db, `locate-fleet:${actor.id}`, 12, 60, "Location refresh is limited to a few runs per hour.");
  const fetchImpl = services?.lookupFetch || fetch;
  let mesh = { status: "skipped", located: 0 };
  if (meshConfigured()) {
    mesh = await syncDevices(db, { lookupFetch: fetchImpl });
  }
  const detected = await refreshDeviceLocations(db, { lookupFetch: fetchImpl, limit: 40 });
  return { ...fleetMap({ db, actor, url: new URL("http://localhost/api/devices/map") }), mesh, detected };
}

function troubleshoot({ db, actor, params }) {
  requireStaff(actor);
  const row = loadDevice(db, actor, params.id);
  return { device: mapDevice(row, actor), ...packTroubleshoot(row) };
}

async function diagnose({ db, actor, params }) {
  requireStaff(actor);
  rateLimit(db, `diagnose:${actor.id}`, 40, 60, "Too many diagnostic runs in the last hour.");
  const row = loadDevice(db, actor, params.id);
  const host = String(row.address || row.last_seen_ip || "").trim();
  if (!host) throw new HttpError(400, "Add an IP address or host name, or sync MeshCentral so the public IP is known.");
  const result = await diagnoseHost(host, row.check_port);
  audit(db, actor.id, "device.diagnose", "device", row.id, row.organization_id, { host, ping: result.ping.ok }, actor.ip);
  return result;
}

function addFinding({ db, actor, params, body }) {
  requireStaff(actor);
  const row = loadDevice(db, actor, params.id);
  const kind = assertEnum(body.kind || "finding", ["finding", "next_step", "note"], "note type");
  const text = assertText(body.body, "Note", 2000);
  const info = db.prepare("INSERT INTO device_findings (device_id, organization_id, created_by, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(row.id, row.organization_id, actor.id, kind, text, nowIso());
  audit(db, actor.id, "device.finding", "device", row.id, row.organization_id, { kind }, actor.ip);
  return { finding: { id: Number(info.lastInsertRowid), kind, body: text, actorName: actor.name, at: nowIso() } };
}

function deskItem(row, configured) {
  const managed = Boolean(row.mesh_node_id);
  const consent = Boolean(row.consent_at);
  const orgActive = row.organization_status === "active";
  const canDiagnose = Boolean(row.address || row.last_seen_ip);
  const canCheck = Boolean(row.address && row.source !== "meshcentral");
  let nextStep = "Open the device to troubleshoot.";
  let blocked = null;
  if (!orgActive) {
    nextStep = "Reactivate the organization first.";
    blocked = "Organization is not active";
  } else if (!managed) {
    nextStep = configured
      ? (row.mesh_group_id
        ? "Install the MeshCentral agent on this computer, then press Sync MeshCentral."
        : "Map this organization's MeshCentral group and sync, or paste the agent node id.")
      : "Consent is recorded. Configure MeshCentral on the server, map the organization group, then sync.";
    blocked = "No MeshCentral agent";
  } else if (!consent) {
    nextStep = "Ask the customer administrator to allow remote support on this device.";
    blocked = "Waiting for customer consent";
  } else if (!configured) {
    nextStep = "Agent and consent are ready. Set MESHCENTRAL_URL and MeshCtrl in the server .env, then restart.";
    blocked = "MeshCentral is not configured on this server";
  } else {
    nextStep = "Ready. Open desktop, terminal or files. The session is recorded.";
  }
  const ready = Boolean(managed && consent && orgActive && configured);
  return {
    id: row.id,
    name: row.name,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    reachability: row.reachability,
    operatingSystem: row.operating_system || "",
    lastChecked: row.last_checked,
    address: row.address || row.last_seen_ip || "",
    managed,
    consent,
    canDiagnose,
    canCheck,
    ready,
    nextStep,
    blocked,
  };
}

function remoteDesk({ db, actor }) {
  requireStaff(actor);
  const configured = meshConfigured();
  const health = db.prepare("SELECT status, detail FROM integration_health WHERE name = 'meshcentral'").get();
  const items = db.prepare(`
    SELECT d.id, d.name, d.organization_id, d.reachability, d.consent_at, d.mesh_node_id, d.operating_system, d.last_checked,
           d.address, d.last_seen_ip, d.source, o.name AS organization_name, o.status AS organization_status, o.mesh_group_id
    FROM devices d JOIN organizations o ON o.id = d.organization_id
    WHERE d.archived_at IS NULL
    ORDER BY CASE WHEN d.mesh_node_id IS NOT NULL AND d.consent_at IS NOT NULL AND o.status = 'active' THEN 0 ELSE 1 END,
             CASE d.reachability WHEN 'online' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, o.name, d.name
    LIMIT 300
  `).all().map((row) => deskItem(row, configured));
  const orgs = db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE status = 'active' AND (mesh_group_id IS NULL OR trim(mesh_group_id) = '')").get().n;
  return {
    meshConfigured: configured,
    meshUrl: configured ? meshConfig().publicUrl : "",
    meshStatus: health?.status || (configured ? "unknown" : "not_configured"),
    meshDetail: health?.detail || (configured ? "Not checked yet." : "Set MESHCENTRAL_URL, MESHCTRL_PATH, MESHCENTRAL_USER and a login key file in the server .env."),
    orgsNeedingGroup: orgs,
    items,
    total: items.length,
    ready: items.filter((item) => item.ready).length,
    needAgent: items.filter((item) => !item.managed).length,
    needConsent: items.filter((item) => item.managed && !item.consent).length,
    canDiagnose: items.filter((item) => item.canDiagnose).length,
  };
}

export const routes = [
  ["GET", "/api/devices", list],
  ["POST", "/api/devices", create],
  ["GET", "/api/devices/export.csv", exportCsv],
  ["GET", "/api/devices/map", fleetMap],
  ["POST", "/api/devices/map/refresh", refreshFleet],
  ["GET", "/api/devices/remote", remoteDesk],
  ["GET", "/api/devices/:id", get],
  ["GET", "/api/devices/:id/availability", availabilityRoute],
  ["GET", "/api/devices/:id/location", getLocation],
  ["POST", "/api/devices/:id/location", setLocation],
  ["POST", "/api/devices/:id/locate", locateDevice],
  ["PATCH", "/api/devices/:id", update],
  ["POST", "/api/devices/:id/archive", archive],
  ["POST", "/api/devices/:id/consent", consent(true)],
  ["POST", "/api/devices/:id/consent/revoke", consent(false)],
  ["POST", "/api/devices/:id/check", checkNow],
  ["POST", "/api/devices/:id/remote", remote],
  ["GET", "/api/devices/:id/troubleshoot", troubleshoot],
  ["POST", "/api/devices/:id/diagnose", diagnose],
  ["POST", "/api/devices/:id/findings", addFinding],
];
