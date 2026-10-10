import { isStaff, requireRole } from "../auth.js";
import { HttpError } from "../errors.js";
import { assertEnum, assertId } from "../validate.js";
import { loadDevice } from "./devices.js";
import { loadTicket } from "./tickets.js";

const CUSTOMER_HIDDEN = /^(login\.|logout|sessions\.|password\.|mfa\.|attachment\.download|device\.export|report\.|invoice\.pdf|payment\.receipt|ticket\.note|ticket\.work_log|meshcentral\.)/;
const INTERNAL_FIELDS = new Set(["address", "check_port", "mesh_group_id", "response_due_at", "resolution_due_at", "target", "port", "timeout_ms", "failure_threshold", "expected_status"]);

function orgRow(db, table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, "Not found.");
  return row;
}

function sameOrg(actor, organizationId) {
  if (!isStaff(actor) && actor.organizationId !== organizationId) throw new HttpError(404, "Not found.");
}

// Each check throws unless the actor may see the record; it mirrors the access rules of the record's own page.
const ACCESS = {
  ticket: (db, actor, id) => loadTicket(db, actor, id),
  device: (db, actor, id) => loadDevice(db, actor, id),
  organization: (db, actor, id) => {
    if (!isStaff(actor)) requireRole(actor, "customer_admin");
    sameOrg(actor, id);
    return orgRow(db, "organizations", id);
  },
  monitor: (db, actor, id) => {
    const row = orgRow(db, "monitors", id);
    sameOrg(actor, row.organization_id);
    if (!isStaff(actor) && !row.customer_visible) throw new HttpError(404, "Not found.");
    return row;
  },
  incident: (db, actor, id) => {
    const row = orgRow(db, "incidents", id);
    sameOrg(actor, row.organization_id);
    if (!isStaff(actor) && !row.customer_visible) throw new HttpError(404, "Not found.");
    if (actor.role === "customer_user" && row.device_id && !db.prepare("SELECT 1 FROM devices WHERE id = ? AND assigned_user_id = ?").get(row.device_id, actor.id)) {
      throw new HttpError(404, "Not found.");
    }
    return row;
  },
  invoice: (db, actor, id) => {
    requireRole(actor, "admin", "customer_admin");
    const row = orgRow(db, "invoices", id);
    sameOrg(actor, row.organization_id);
    return row;
  },
  payment: (db, actor, id) => {
    requireRole(actor, "admin", "customer_admin");
    const row = orgRow(db, "payments", id);
    sameOrg(actor, row.organization_id);
    return row;
  },
  user: (db, actor, id) => {
    requireRole(actor, "admin", "customer_admin");
    const row = orgRow(db, "users", id);
    if (actor.role === "customer_admin" && row.organization_id !== actor.organizationId) throw new HttpError(404, "Not found.");
    return row;
  },
  service_plan: (db, actor, id) => {
    requireRole(actor, "admin");
    return orgRow(db, "service_plans", id);
  },
  sla_policy: (db, actor, id) => {
    requireRole(actor, "admin");
    return orgRow(db, "sla_policies", id);
  },
};

export const HISTORY_TYPES = Object.keys(ACCESS);

const NAME_LOOKUPS = {
  assigned_to: "users",
  assigned_user_id: "users",
  plan_id: "service_plans",
  device_id: "devices",
};

function displayValue(db, field, value) {
  if (value === null || value === undefined || value === "") return null;
  const table = NAME_LOOKUPS[field];
  if (table) return db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(value)?.name ?? `#${value}`;
  return value;
}

export function mapEvent(db, row, actor) {
  const detail = row.detail ? JSON.parse(row.detail) : {};
  const staff = isStaff(actor);
  const changeList = Object.entries(detail.changes || {})
    .filter(([field]) => staff || !INTERNAL_FIELDS.has(field))
    .map(([field, [from, to]]) => ({ field, from: displayValue(db, field, from), to: displayValue(db, field, to) }));
  delete detail.changes;
  return {
    id: row.id,
    at: row.created_at,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorName: row.actor_name || "System",
    actorRole: row.actor_role || null,
    reason: row.reason || detail.reason || null,
    changes: changeList,
    detail: staff ? detail : {},
    ip: actor.role === "admin" ? row.ip : undefined,
  };
}

function history({ db, actor, url }) {
  const type = assertEnum(url.searchParams.get("type"), HISTORY_TYPES, "record type");
  const id = assertId(url.searchParams.get("id"));
  ACCESS[type](db, actor, id);
  const related = type === "ticket" ? " OR (a.entity_type = 'attachment' AND json_extract(a.detail, '$.ticket') = ?)" : "";
  const args = type === "ticket" ? [type, String(id), id] : [type, String(id)];
  const rows = db.prepare(`
    SELECT a.*, u.name AS actor_name, u.role AS actor_role FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
    WHERE (a.entity_type = ? AND a.entity_id = ?)${related}
    ORDER BY a.id DESC LIMIT 200
  `).all(...args);
  const visible = isStaff(actor) ? rows : rows.filter((row) => !CUSTOMER_HIDDEN.test(row.action));
  return { items: visible.map((row) => mapEvent(db, row, actor)) };
}

export const routes = [
  ["GET", "/api/history", history],
];
