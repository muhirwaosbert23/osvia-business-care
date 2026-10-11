import { isStaff } from "../auth.js";
import { likePattern } from "../validate.js";

const LIMIT = 6;

function ticketScope(actor) {
  if (actor.role === "admin") return { sql: "1 = 1", args: [] };
  if (actor.role === "technician") return { sql: "(t.assigned_to = ? OR t.assigned_to IS NULL)", args: [actor.id] };
  if (actor.role === "customer_admin") return { sql: "t.organization_id = ?", args: [actor.organizationId] };
  return { sql: "t.organization_id = ? AND t.created_by = ?", args: [actor.organizationId, actor.id] };
}

function deviceScope(actor) {
  if (isStaff(actor)) return { sql: "1 = 1", args: [] };
  if (actor.role === "customer_admin") return { sql: "d.organization_id = ?", args: [actor.organizationId] };
  return { sql: "d.organization_id = ? AND d.assigned_user_id = ?", args: [actor.organizationId, actor.id] };
}

function searchTickets(db, actor, like) {
  const scope = ticketScope(actor);
  const rows = db.prepare(`
    SELECT t.id, t.number, t.title, t.status, o.name AS organization_name
    FROM tickets t JOIN organizations o ON o.id = t.organization_id
    WHERE ${scope.sql} AND (t.title LIKE ? ESCAPE '\\' OR t.number LIKE ? ESCAPE '\\')
    ORDER BY t.updated_at DESC, t.id DESC LIMIT ${LIMIT}
  `).all(...scope.args, like, like);
  return rows.map((row) => ({
    type: "ticket",
    id: row.id,
    title: row.title,
    hint: isStaff(actor) ? `${row.number} · ${row.organization_name}` : row.number,
    href: `#/tickets/${row.id}`,
  }));
}

function searchDevices(db, actor, like) {
  const scope = deviceScope(actor);
  const rows = db.prepare(`
    SELECT d.id, d.name, d.asset_tag, o.name AS organization_name
    FROM devices d JOIN organizations o ON o.id = d.organization_id
    WHERE d.archived_at IS NULL AND ${scope.sql}
      AND (d.name LIKE ? ESCAPE '\\' OR IFNULL(d.serial_number, '') LIKE ? ESCAPE '\\' OR IFNULL(d.asset_tag, '') LIKE ? ESCAPE '\\' OR IFNULL(d.model, '') LIKE ? ESCAPE '\\')
    ORDER BY d.name LIMIT ${LIMIT}
  `).all(...scope.args, like, like, like, like);
  return rows.map((row) => ({
    type: "device",
    id: row.id,
    title: row.name,
    hint: [isStaff(actor) ? row.organization_name : "", row.asset_tag ? `Tag ${row.asset_tag}` : ""].filter(Boolean).join(" · "),
    href: `#/devices/${row.id}`,
  }));
}

function searchOrganizations(db, like) {
  const rows = db.prepare(`
    SELECT id, name, status, location FROM organizations
    WHERE name LIKE ? ESCAPE '\\' OR contact_name LIKE ? ESCAPE '\\' OR contact_email LIKE ? ESCAPE '\\'
    ORDER BY name LIMIT ${LIMIT}
  `).all(like, like, like);
  return rows.map((row) => ({
    type: "organization",
    id: row.id,
    title: row.name,
    hint: [row.status, row.location || ""].filter(Boolean).join(" · "),
    href: `#/organizations/${row.id}`,
  }));
}

export function search({ db, actor, url }) {
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 80);
  if (q.length < 2) return { items: [] };
  const like = likePattern(q);
  const items = [
    ...searchTickets(db, actor, like),
    ...searchDevices(db, actor, like),
    ...(isStaff(actor) ? searchOrganizations(db, like) : []),
  ];
  return { items };
}

export const routes = [
  ["GET", "/api/search", search],
];
