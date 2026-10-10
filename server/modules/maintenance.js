import { isStaff, requireStaff, scopeOrgId } from "../auth.js";
import { audit, transaction } from "../db.js";
import { HttpError } from "../errors.js";
import { reply, sendFile } from "../http.js";
import { notifyUsers } from "../notify.js";
import { buildPdf } from "../pdf.js";
import { addDays, assertDate, assertId, assertText, nowIso, nullableText, optionalInt, pageParams, reportPeriod, todayUtc } from "../validate.js";
import { mustOrg } from "./organizations.js";

function orgFilter(actor, url, column) {
  if (!isStaff(actor)) return { sql: `${column} = ?`, args: [actor.organizationId] };
  const requested = url.searchParams.get("organizationId");
  return requested ? { sql: `${column} = ?`, args: [scopeOrgId(actor, requested)] } : { sql: "1 = 1", args: [] };
}

function mapSchedule(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    title: row.title,
    nextDue: row.next_due,
    intervalDays: row.interval_days,
    notes: row.notes || "",
    active: row.active === 1,
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name || "",
    deviceId: row.device_id,
    deviceName: row.device_name || "",
    lastCompletedAt: row.last_completed_at,
    overdue: row.active === 1 && row.next_due < todayUtc(),
  };
}

const SCHEDULE_SELECT = `
  SELECT s.*, o.name AS organization_name, u.name AS assignee_name, d.name AS device_name
  FROM maintenance_schedules s JOIN organizations o ON o.id = s.organization_id
  LEFT JOIN users u ON u.id = s.assigned_to LEFT JOIN devices d ON d.id = s.device_id
`;

function listSchedules({ db, actor, url }) {
  const { page, limit, offset } = pageParams(url);
  const column = url.searchParams.get("sort") === "title" ? "s.title" : "s.next_due";
  const dir = url.searchParams.get("dir") === "desc" ? "DESC" : "ASC";
  const f = orgFilter(actor, url, "s.organization_id");
  const where = [f.sql, "s.active = 1"];
  const args = [...f.args];
  if (url.searchParams.get("overdue") === "1") where.push("s.next_due < ?"), args.push(todayUtc());
  if (url.searchParams.get("assigned") === "me") where.push("s.assigned_to = ?"), args.push(actor.id);
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM maintenance_schedules s ${clause}`).get(...args).n;
  const items = db.prepare(`${SCHEDULE_SELECT} ${clause} ORDER BY ${column} ${dir}, s.id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(mapSchedule);
  return { items, page, pageSize: limit, total };
}

function staffUser(db, value) {
  if (value === null || value === undefined || value === "") return null;
  const id = assertId(value, "Technician");
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND active = 1 AND role IN ('admin', 'technician')").get(id)) throw new HttpError(400, "Assign the schedule to an active technician.");
  return id;
}

function orgDevice(db, organizationId, value) {
  if (value === null || value === undefined || value === "") return null;
  const id = assertId(value, "Device");
  if (!db.prepare("SELECT 1 FROM devices WHERE id = ? AND organization_id = ?").get(id, organizationId)) throw new HttpError(400, "That device belongs to another organization.");
  return id;
}

function createSchedule({ db, actor, body }) {
  requireStaff(actor);
  const organizationId = scopeOrgId(actor, body.organizationId);
  mustOrg(db, organizationId);
  const info = db.prepare(`
    INSERT INTO maintenance_schedules (organization_id, title, next_due, interval_days, notes, assigned_to, device_id, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    organizationId,
    assertText(body.title, "Task", 160),
    assertDate(body.nextDue, "Next due date"),
    optionalInt(body.intervalDays, "Repeat every (days)", 1, 3650),
    nullableText(body.notes, 2000, "Notes"),
    staffUser(db, body.assignedTo),
    orgDevice(db, organizationId, body.deviceId),
    nowIso(),
  );
  audit(db, actor.id, "maintenance_schedule.create", "maintenance_schedule", info.lastInsertRowid, organizationId, null, actor.ip);
  return reply(201, { schedule: mapSchedule(db.prepare(`${SCHEDULE_SELECT} WHERE s.id = ?`).get(info.lastInsertRowid)) });
}

function updateSchedule({ db, actor, params, body }) {
  requireStaff(actor);
  const row = db.prepare("SELECT * FROM maintenance_schedules WHERE id = ?").get(params.id);
  if (!row) throw new HttpError(404, "Not found.");
  db.prepare(`
    UPDATE maintenance_schedules SET title = ?, next_due = ?, interval_days = ?, notes = ?, assigned_to = ?, device_id = ?, active = ?, reminder_sent_for = CASE WHEN next_due = ? THEN reminder_sent_for ELSE NULL END WHERE id = ?
  `).run(
    body.title === undefined ? row.title : assertText(body.title, "Task", 160),
    body.nextDue === undefined ? row.next_due : assertDate(body.nextDue, "Next due date"),
    body.intervalDays === undefined ? row.interval_days : optionalInt(body.intervalDays, "Repeat every (days)", 1, 3650),
    body.notes === undefined ? row.notes : nullableText(body.notes, 2000, "Notes"),
    body.assignedTo === undefined ? row.assigned_to : staffUser(db, body.assignedTo),
    body.deviceId === undefined ? row.device_id : orgDevice(db, row.organization_id, body.deviceId),
    body.active === undefined ? row.active : (body.active ? 1 : 0),
    body.nextDue ?? row.next_due,
    row.id,
  );
  audit(db, actor.id, "maintenance_schedule.update", "maintenance_schedule", row.id, row.organization_id, null, actor.ip);
  return { schedule: mapSchedule(db.prepare(`${SCHEDULE_SELECT} WHERE s.id = ?`).get(row.id)) };
}

function insertRecord(db, actor, { organizationId, deviceId, scheduleId, summary, performedAt, minutes }) {
  const info = db.prepare(`
    INSERT INTO maintenance_records (organization_id, device_id, technician_id, summary, performed_at, schedule_id, minutes_spent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(organizationId, deviceId, actor.id, summary, performedAt, scheduleId, minutes, nowIso());
  return Number(info.lastInsertRowid);
}

function completeSchedule({ db, actor, params, body }) {
  requireStaff(actor);
  const row = db.prepare("SELECT * FROM maintenance_schedules WHERE id = ? AND active = 1").get(params.id);
  if (!row) throw new HttpError(404, "Not found.");
  const summary = assertText(body.summary, "Work performed", 4000);
  const performedAt = body.performedAt ? assertDate(body.performedAt, "Date performed") : todayUtc();
  const minutes = optionalInt(body.minutesSpent, "Time spent (minutes)", 1, 1440);
  transaction(db, () => {
    insertRecord(db, actor, { organizationId: row.organization_id, deviceId: row.device_id, scheduleId: row.id, summary, performedAt, minutes });
    if (row.interval_days) {
      let next = addDays(row.next_due, row.interval_days);
      while (next <= performedAt) next = addDays(next, row.interval_days);
      db.prepare("UPDATE maintenance_schedules SET next_due = ?, last_completed_at = ?, reminder_sent_for = NULL WHERE id = ?").run(next, nowIso(), row.id);
    } else {
      db.prepare("UPDATE maintenance_schedules SET active = 0, last_completed_at = ? WHERE id = ?").run(nowIso(), row.id);
    }
    audit(db, actor.id, "maintenance_schedule.complete", "maintenance_schedule", row.id, row.organization_id, null, actor.ip);
    const admins = db.prepare("SELECT id FROM users WHERE organization_id = ? AND role = 'customer_admin' AND active = 1").all(row.organization_id).map((u) => u.id);
    notifyUsers(db, admins, { title: `Maintenance completed: ${row.title}`, body: summary.slice(0, 400), kind: "maintenance", link: "maintenance" });
  });
  return { schedule: mapSchedule(db.prepare(`${SCHEDULE_SELECT} WHERE s.id = ?`).get(row.id)) };
}

function listRecords({ db, actor, url }) {
  const { page, limit, offset } = pageParams(url);
  const f = orgFilter(actor, url, "m.organization_id");
  const total = db.prepare(`SELECT COUNT(*) AS n FROM maintenance_records m WHERE ${f.sql}`).get(...f.args).n;
  const items = db.prepare(`
    SELECT m.*, o.name AS organization_name, u.name AS technician, d.name AS device_name
    FROM maintenance_records m JOIN organizations o ON o.id = m.organization_id JOIN users u ON u.id = m.technician_id LEFT JOIN devices d ON d.id = m.device_id
    WHERE ${f.sql} ORDER BY m.performed_at DESC, m.id DESC LIMIT ? OFFSET ?
  `).all(...f.args, limit, offset).map((m) => ({
    id: m.id,
    organizationName: m.organization_name,
    deviceName: m.device_name || "",
    technician: m.technician,
    summary: m.summary,
    performedAt: m.performed_at,
    minutesSpent: isStaff(actor) ? m.minutes_spent : null,
  }));
  return { items, page, pageSize: limit, total };
}

function createRecord({ db, actor, body }) {
  requireStaff(actor);
  const organizationId = scopeOrgId(actor, body.organizationId);
  mustOrg(db, organizationId);
  const id = insertRecord(db, actor, {
    organizationId,
    deviceId: orgDevice(db, organizationId, body.deviceId),
    scheduleId: null,
    summary: assertText(body.summary, "Work performed", 4000),
    performedAt: assertDate(body.performedAt, "Date performed"),
    minutes: optionalInt(body.minutesSpent, "Time spent (minutes)", 1, 1440),
  });
  audit(db, actor.id, "maintenance.record", "maintenance_record", id, organizationId, null, actor.ip);
  return reply(201, { id });
}

function reportPdf({ db, actor, url, res }) {
  const organizationId = scopeOrgId(actor, url.searchParams.get("organizationId"));
  const org = mustOrg(db, organizationId);
  const { from, to } = reportPeriod(url);
  const records = db.prepare(`
    SELECT m.*, u.name AS technician, d.name AS device_name FROM maintenance_records m JOIN users u ON u.id = m.technician_id LEFT JOIN devices d ON d.id = m.device_id
    WHERE m.organization_id = ? AND m.performed_at BETWEEN ? AND ? ORDER BY m.performed_at
  `).all(organizationId, from, to);
  const upcoming = db.prepare("SELECT * FROM maintenance_schedules WHERE organization_id = ? AND active = 1 ORDER BY next_due LIMIT 20").all(organizationId);
  const rows = [
    `Organization: ${org.name}`,
    `Period: ${from} to ${to}`,
    `Generated: ${nowIso().slice(0, 16).replace("T", " ")} UTC`,
    "",
    { heading: `Work performed (${records.length})` },
    ...(records.length ? records.flatMap((r) => [`${r.performed_at}  ${r.device_name || "General"}  by ${r.technician}`, `   ${r.summary}`]) : ["No maintenance was recorded in this period."]),
    "",
    { heading: "Upcoming maintenance" },
    ...(upcoming.length ? upcoming.map((s) => `${s.next_due}  ${s.title}${s.next_due < todayUtc() ? "  (overdue)" : ""}`) : ["No scheduled maintenance."]),
  ];
  audit(db, actor.id, "maintenance.report", "organization", organizationId, organizationId, { from, to }, actor.ip);
  sendFile(res, { body: buildPdf("Maintenance report", rows), type: "application/pdf", filename: `maintenance-${organizationId}-${from}-${to}.pdf` });
}

export const routes = [
  ["GET", "/api/maintenance/schedules", listSchedules],
  ["POST", "/api/maintenance/schedules", createSchedule],
  ["PATCH", "/api/maintenance/schedules/:id", updateSchedule],
  ["POST", "/api/maintenance/schedules/:id/complete", completeSchedule],
  ["GET", "/api/maintenance/records", listRecords],
  ["POST", "/api/maintenance/records", createRecord],
  ["GET", "/api/maintenance/report.pdf", reportPdf],
];
