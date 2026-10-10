import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isStaff, requireOperationalOrg, requireStaff, scopeOrgId } from "../auth.js";
import { ACTIVE_TICKET_STATUSES, CATEGORIES, IMPACTS, PRIORITIES, STAFF_TRANSITIONS, TICKET_STATUSES } from "../constants.js";
import { audit, changes as diff, getSetting, transaction } from "../db.js";
import { HttpError } from "../errors.js";
import { reply, sendFile } from "../http.js";
import { notifyUsers, staffIds } from "../notify.js";
import { addBusinessMinutes, businessMinutesBetween, deadlinesFor, findPolicy, loadHolidays, slaState } from "../sla.js";
import { assertEnum, assertId, assertInt, assertText, likePattern, nowIso, nullableText, optionalText, pageParams } from "../validate.js";
import { mustOrg } from "./organizations.js";

const MAX_UPLOAD = 5 * 1024 * 1024;
const TICKET_SELECT = `
  SELECT t.*, o.name AS organization_name, c.name AS creator_name, c.email AS creator_email, a.name AS assignee_name,
         d.name AS device_name, p.name AS policy_name,
         (SELECT COALESCE(SUM(minutes_spent), 0) FROM ticket_notes n WHERE n.ticket_id = t.id) AS minutes_logged
  FROM tickets t
  JOIN organizations o ON o.id = t.organization_id
  JOIN users c ON c.id = t.created_by
  LEFT JOIN users a ON a.id = t.assigned_to
  LEFT JOIN devices d ON d.id = t.device_id
  LEFT JOIN sla_policies p ON p.id = t.sla_policy_id
`;

export function mapTicket(row, actor) {
  const sla = slaState(row);
  const data = {
    id: row.id,
    number: row.number,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    title: row.title,
    description: row.description,
    category: row.category,
    priority: row.priority,
    impact: row.impact,
    status: row.status,
    createdBy: row.created_by,
    requesterName: row.creator_name,
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name || "",
    deviceId: row.device_id,
    deviceName: row.device_name || "",
    resolutionSummary: row.resolution_summary || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    firstResponseAt: row.first_response_at,
    responseDueAt: row.response_due_at,
    resolutionDueAt: row.resolution_due_at,
    slaPaused: Boolean(row.sla_paused_at),
    sla,
    policyName: row.policy_name || "",
    reopenedCount: row.reopened_count,
  };
  if (actor && isStaff(actor)) {
    data.minutesLogged = row.minutes_logged;
    data.escalatedAt = row.escalated_at;
  }
  return data;
}

function visibilityClause(actor) {
  if (actor.role === "admin") return { sql: "1 = 1", args: [] };
  if (actor.role === "technician") return { sql: "(t.assigned_to = ? OR t.assigned_to IS NULL)", args: [actor.id] };
  if (actor.role === "customer_admin") return { sql: "t.organization_id = ?", args: [actor.organizationId] };
  return { sql: "t.organization_id = ? AND t.created_by = ?", args: [actor.organizationId, actor.id] };
}

export function loadTicket(db, actor, id) {
  const scope = visibilityClause(actor);
  const row = db.prepare(`${TICKET_SELECT} WHERE t.id = ? AND ${scope.sql}`).get(id, ...scope.args);
  if (!row) throw new HttpError(404, "Not found.");
  return row;
}

function list({ db, actor, url }) {
  const { page, limit, offset, q, orderBy } = pageParams(url, {
    created: "t.created_at", updated: "t.updated_at", priority: "CASE t.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END",
    due: "COALESCE(t.response_due_at, t.resolution_due_at)", status: "t.status", number: "t.id",
  }, "created");
  const scope = visibilityClause(actor);
  const where = [scope.sql];
  const args = [...scope.args];
  const filters = url.searchParams;
  if (isStaff(actor) && filters.get("organizationId")) {
    where.push("t.organization_id = ?");
    args.push(scopeOrgId(actor, filters.get("organizationId")));
  }
  if (filters.get("status") === "active") where.push(`t.status IN (${ACTIVE_TICKET_STATUSES.map(() => "?").join(",")})`), args.push(...ACTIVE_TICKET_STATUSES);
  else if (filters.get("status")) where.push("t.status = ?"), args.push(assertEnum(filters.get("status"), TICKET_STATUSES, "status"));
  if (filters.get("priority")) where.push("t.priority = ?"), args.push(assertEnum(filters.get("priority"), PRIORITIES, "priority"));
  if (filters.get("category")) where.push("t.category = ?"), args.push(assertEnum(filters.get("category"), CATEGORIES, "category"));
  if (filters.get("assigned") === "me") where.push("t.assigned_to = ?"), args.push(actor.id);
  if (filters.get("assigned") === "none") where.push("t.assigned_to IS NULL");
  if (filters.get("breached") === "1") where.push("(t.response_breached = 1 OR t.resolution_breached = 1)");
  if (filters.get("deviceId")) where.push("t.device_id = ?"), args.push(assertId(filters.get("deviceId")));
  if (q) {
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR t.number LIKE ? ESCAPE '\\')");
    args.push(likePattern(q), likePattern(q), likePattern(q));
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${clause}`).get(...args).n;
  const rows = db.prepare(`${TICKET_SELECT} ${clause} ORDER BY ${orderBy}, t.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { items: rows.map((row) => mapTicket(row, actor)), page, pageSize: limit, total };
}

function detail(db, actor, id) {
  const row = loadTicket(db, actor, id);
  const customer = !isStaff(actor);
  const notes = db.prepare(`
    SELECT n.*, u.name AS author_name, u.role AS author_role FROM ticket_notes n JOIN users u ON u.id = n.author_id
    WHERE n.ticket_id = ? ${customer ? "AND n.visibility = 'customer'" : ""} ORDER BY n.id
  `).all(id).map((note) => ({
    id: note.id,
    authorName: note.author_name,
    authorIsStaff: ["admin", "technician"].includes(note.author_role),
    body: note.body,
    visibility: note.visibility,
    kind: note.kind,
    minutesSpent: customer ? null : note.minutes_spent,
    createdAt: note.created_at,
  }));
  const events = db.prepare(`
    SELECT e.*, u.name AS actor_name FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.ticket_id = ? ORDER BY e.id
  `).all(id).map((event) => ({
    id: event.id,
    actorName: event.actor_name || "System",
    fromStatus: event.from_status,
    toStatus: event.to_status,
    note: customer && event.note?.startsWith("internal:") ? "" : (event.note || "").replace(/^internal:/, ""),
    createdAt: event.created_at,
  }));
  const attachments = db.prepare(`
    SELECT a.*, u.name AS uploader FROM attachments a JOIN users u ON u.id = a.uploaded_by
    WHERE a.ticket_id = ? ${customer ? "AND a.visibility = 'customer'" : ""} ORDER BY a.id
  `).all(id).map((file) => ({ id: file.id, name: file.original_name, size: file.size, mime: file.mime, visibility: file.visibility, uploader: file.uploader, createdAt: file.created_at }));
  const reopenDays = Number(getSetting(db, "reopen_days", "14"));
  const canReopen = !isStaff(actor) && row.status === "resolved" && row.resolved_at && Date.now() - Date.parse(row.resolved_at) <= reopenDays * 86400000;
  return { ticket: mapTicket(row, actor), notes, events, attachments, permissions: { canReopen, canClose: !isStaff(actor) && row.status === "resolved", canReply: row.status !== "closed" } };
}

function recordEvent(db, ticketId, actorId, from, to, note = null) {
  db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(ticketId, actorId, from, to, note, nowIso());
}

function refreshBreaches(db, ticketId) {
  const row = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId);
  const sla = slaState(row);
  db.prepare("UPDATE tickets SET response_breached = ?, resolution_breached = ? WHERE id = ?").run(sla.response === "breached" ? 1 : 0, sla.resolution === "breached" ? 1 : 0, ticketId);
}

function policyForOrg(db, org, priority, category) {
  return findPolicy(db, org.subscription_status === "active" ? org.plan_id : null, priority, category);
}

function create({ db, actor, body }) {
  requireOperationalOrg(db, actor);
  const organizationId = scopeOrgId(actor, body.organizationId);
  const org = mustOrg(db, organizationId);
  if (org.status === "suspended") throw new HttpError(400, "This organization is suspended.");
  const title = assertText(body.title, "Subject", 160);
  const description = assertText(body.description, "Description", 8000);
  const priority = assertEnum(body.priority || "normal", PRIORITIES, "priority");
  const category = assertEnum(body.category || "other", CATEGORIES, "category");
  const impact = assertEnum(body.impact || "single_user", IMPACTS, "impact");
  let requesterId = actor.id;
  if (isStaff(actor) && body.requesterId) {
    requesterId = assertId(body.requesterId, "Requester");
    const requester = db.prepare("SELECT id FROM users WHERE id = ? AND organization_id = ? AND active = 1").get(requesterId, organizationId);
    if (!requester) throw new HttpError(400, "The requester must be an active user of this organization.");
  }
  let deviceId = null;
  if (body.deviceId) {
    deviceId = assertId(body.deviceId, "Device");
    const device = db.prepare("SELECT id, assigned_user_id FROM devices WHERE id = ? AND organization_id = ? AND archived_at IS NULL").get(deviceId, organizationId);
    if (!device || (actor.role === "customer_user" && device.assigned_user_id !== actor.id)) throw new HttpError(400, "Choose a device from your organization.");
  }
  const now = nowIso();
  const policy = policyForOrg(db, org, priority, category);
  const due = deadlinesFor(db, policy, now);
  const id = transaction(db, () => {
    const info = db.prepare(`
      INSERT INTO tickets (organization_id, created_by, title, description, priority, category, impact, device_id, status,
        sla_policy_id, response_due_at, resolution_due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)
    `).run(organizationId, requesterId, title, description, priority, category, impact, deviceId, policy?.id ?? null, due.responseDue, due.resolutionDue, now, now);
    const ticketId = Number(info.lastInsertRowid);
    const number = `OBC-${String(ticketId).padStart(6, "0")}`;
    db.prepare("UPDATE tickets SET number = ? WHERE id = ?").run(number, ticketId);
    recordEvent(db, ticketId, actor.id, null, "new", isStaff(actor) ? "Logged by OSVIA staff" : null);
    audit(db, actor.id, "ticket.create", "ticket", ticketId, organizationId, { priority, category }, actor.ip);
    notifyUsers(db, staffIds(db), { title: `${priority === "urgent" ? "URGENT " : ""}New ticket ${number}`, body: `${org.name}: ${title}`, kind: "ticket", link: `tickets/${ticketId}` });
    notifyUsers(db, [requesterId], { title: `We received ${number}`, body: `${title}. ${due.responseDue ? `First response target: ${due.responseDue}.` : "No response target applies to this ticket."}`, kind: "ticket", link: `tickets/${ticketId}` });
    return ticketId;
  });
  return reply(201, detail(db, actor, id));
}

function applyStatus(db, ticket, to, actor, now) {
  const from = ticket.status;
  const updates = { status: to };
  if (isStaff(actor) && !ticket.first_response_at && ["in_progress", "pending_customer", "resolved"].includes(to)) updates.first_response_at = now;
  if (to === "pending_customer" && ticket.resolution_due_at && !ticket.sla_paused_at) {
    updates.sla_paused_at = now;
    const policy = ticket.sla_policy_id ? db.prepare("SELECT * FROM sla_policies WHERE id = ?").get(ticket.sla_policy_id) : null;
    updates.sla_remaining_minutes = policy ? businessMinutesBetween(Date.parse(now), Date.parse(ticket.resolution_due_at), policy, loadHolidays(db)) : 0;
  }
  if (from === "pending_customer" && to !== "pending_customer" && ticket.sla_paused_at) {
    const policy = ticket.sla_policy_id ? db.prepare("SELECT * FROM sla_policies WHERE id = ?").get(ticket.sla_policy_id) : null;
    if (policy && ticket.sla_remaining_minutes > 0) {
      updates.resolution_due_at = new Date(addBusinessMinutes(Date.parse(now), ticket.sla_remaining_minutes, policy, loadHolidays(db))).toISOString();
    }
    updates.sla_paused_at = null;
    updates.sla_remaining_minutes = null;
  }
  if (to === "resolved") updates.resolved_at = now;
  if (to === "closed") {
    updates.closed_at = now;
    if (!ticket.resolved_at) updates.resolved_at = now;
  }
  if (to === "open" && (from === "resolved" || from === "closed")) {
    updates.resolved_at = null;
    updates.closed_at = null;
    updates.reopened_count = ticket.reopened_count + 1;
  }
  return updates;
}

function writeUpdates(db, id, updates) {
  const keys = Object.keys(updates);
  if (!keys.length) return;
  db.prepare(`UPDATE tickets SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((key) => updates[key]), nowIso(), id);
}

function update({ db, actor, params, body }) {
  requireStaff(actor);
  const ticket = loadTicket(db, actor, params.id);
  const now = nowIso();
  const updates = {};
  const changes = [];

  if (body.resolutionSummary !== undefined) updates.resolution_summary = optionalText(body.resolutionSummary, 8000, "Resolution summary") || null;
  if (body.priority !== undefined || body.category !== undefined) {
    const priority = body.priority === undefined ? ticket.priority : assertEnum(body.priority, PRIORITIES, "priority");
    const category = body.category === undefined ? ticket.category : assertEnum(body.category, CATEGORIES, "category");
    if (priority !== ticket.priority || category !== ticket.category) {
      const policy = policyForOrg(db, mustOrg(db, ticket.organization_id), priority, category);
      const due = deadlinesFor(db, policy, ticket.created_at);
      Object.assign(updates, { priority, category, sla_policy_id: policy?.id ?? null, response_due_at: due.responseDue, resolution_due_at: ticket.sla_paused_at ? ticket.resolution_due_at : due.resolutionDue });
      changes.push(`internal:Priority ${priority}, category ${category}. SLA deadlines recalculated from the creation time.`);
    }
  }
  if (body.impact !== undefined) updates.impact = assertEnum(body.impact, IMPACTS, "impact");
  if (body.deviceId !== undefined) {
    if (!body.deviceId) updates.device_id = null;
    else {
      const deviceId = assertId(body.deviceId, "Device");
      if (!db.prepare("SELECT 1 FROM devices WHERE id = ? AND organization_id = ?").get(deviceId, ticket.organization_id)) throw new HttpError(400, "That device belongs to another organization.");
      updates.device_id = deviceId;
    }
  }
  if (body.assignedTo !== undefined) {
    const assignee = body.assignedTo === null || body.assignedTo === "" ? null : assertId(body.assignedTo, "Assignee");
    if (actor.role === "technician" && assignee !== null && assignee !== actor.id) throw new HttpError(403, "Technicians can only assign tickets to themselves.");
    if (actor.role === "technician" && assignee === null && ticket.assigned_to !== actor.id) throw new HttpError(403, "You can only release tickets assigned to you.");
    if (assignee !== null && !db.prepare("SELECT 1 FROM users WHERE id = ? AND active = 1 AND role IN ('admin', 'technician')").get(assignee)) {
      throw new HttpError(400, "Assign the ticket to an active technician or administrator.");
    }
    if (assignee !== ticket.assigned_to) {
      updates.assigned_to = assignee;
      if (ticket.status === "new" && assignee && body.status === undefined) body.status = "open";
      changes.push(assignee ? `Assigned to ${db.prepare("SELECT name FROM users WHERE id = ?").get(assignee).name}` : "Unassigned");
    }
  }
  let statusChanged = false;
  if (body.status !== undefined && body.status !== ticket.status) {
    const to = assertEnum(body.status, TICKET_STATUSES, "status");
    if (!STAFF_TRANSITIONS[ticket.status].includes(to)) throw new HttpError(400, `A ticket cannot move from ${ticket.status} to ${to}.`);
    if (ticket.status === "closed" && actor.role !== "admin") throw new HttpError(403, "Only an administrator can reopen a closed ticket.");
    const summary = updates.resolution_summary === undefined ? ticket.resolution_summary : updates.resolution_summary;
    if ((to === "resolved" || to === "closed") && !summary) throw new HttpError(400, "Add a resolution summary before resolving the ticket.");
    Object.assign(updates, applyStatus(db, { ...ticket, ...updates }, to, actor, now));
    statusChanged = true;
  }
  if (!Object.keys(updates).length) return detail(db, actor, ticket.id);

  transaction(db, () => {
    writeUpdates(db, ticket.id, updates);
    if (statusChanged) recordEvent(db, ticket.id, actor.id, ticket.status, updates.status, changes.filter((c) => !c.startsWith("internal:")).join(". ") || null);
    else if (changes.length) recordEvent(db, ticket.id, actor.id, ticket.status, ticket.status, changes.join(". "));
    refreshBreaches(db, ticket.id);
    audit(db, actor.id, "ticket.update", "ticket", ticket.id, ticket.organization_id, {
      changes: diff(ticket, { ...ticket, ...updates }, ["status", "priority", "category", "impact", "assigned_to", "device_id", "resolution_summary", "response_due_at", "resolution_due_at"]),
      reason: nullableText(body.reason, 300, "Reason"),
    }, actor.ip);
    if (statusChanged) {
      notifyUsers(db, [ticket.created_by], {
        title: `${ticket.number} is ${updates.status.replaceAll("_", " ")}`,
        body: updates.status === "resolved" ? `Resolution: ${(updates.resolution_summary ?? ticket.resolution_summary ?? "").slice(0, 300)}` : `Status changed from ${ticket.status.replaceAll("_", " ")}.`,
        kind: "ticket",
        link: `tickets/${ticket.id}`,
      });
    }
    if (updates.assigned_to && updates.assigned_to !== actor.id) {
      notifyUsers(db, [updates.assigned_to], { title: `${ticket.number} assigned to you`, body: ticket.title, kind: "ticket", link: `tickets/${ticket.id}` });
    }
  });
  return detail(db, actor, ticket.id);
}

function addNote({ db, actor, params, body }) {
  const ticket = loadTicket(db, actor, params.id);
  if (ticket.status === "closed") throw new HttpError(400, "This ticket is closed. Open a new ticket and mention its number.");
  const text = assertText(body.body, "Message", 8000);
  const staff = isStaff(actor);
  const kind = staff ? assertEnum(body.kind || "reply", ["reply", "note", "work_log"], "entry type") : "reply";
  const visibility = kind === "reply" ? "customer" : "internal";
  const minutes = kind === "work_log" ? assertInt(body.minutesSpent, "Time spent (minutes)", 1, 1440) : null;
  const now = nowIso();
  transaction(db, () => {
    db.prepare("INSERT INTO ticket_notes (ticket_id, author_id, body, visibility, kind, minutes_spent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(ticket.id, actor.id, text, visibility, kind, minutes, now);
    const updates = {};
    if (staff && kind === "reply" && !ticket.first_response_at) updates.first_response_at = now;
    if (!staff && ticket.status === "pending_customer") {
      Object.assign(updates, applyStatus(db, ticket, "open", actor, now));
      recordEvent(db, ticket.id, actor.id, "pending_customer", "open", "Customer replied");
    }
    writeUpdates(db, ticket.id, updates);
    refreshBreaches(db, ticket.id);
    audit(db, actor.id, `ticket.${kind}`, "ticket", ticket.id, ticket.organization_id, minutes ? { minutes } : null, actor.ip);
    if (staff && kind === "reply") {
      notifyUsers(db, [ticket.created_by], { title: `Reply on ${ticket.number}`, body: text.slice(0, 400), kind: "ticket", link: `tickets/${ticket.id}` });
    }
    if (!staff) {
      notifyUsers(db, ticket.assigned_to ? [ticket.assigned_to] : staffIds(db), { title: `Customer replied on ${ticket.number}`, body: text.slice(0, 400), kind: "ticket", link: `tickets/${ticket.id}` });
    }
  });
  return reply(201, detail(db, actor, ticket.id));
}

function customerAction(action) {
  return ({ db, actor, params }) => {
    if (isStaff(actor)) throw new HttpError(400, "Staff change status from the ticket controls.");
    const ticket = loadTicket(db, actor, params.id);
    const view = detail(db, actor, ticket.id);
    if (action === "reopen" && !view.permissions.canReopen) throw new HttpError(400, "This ticket can no longer be reopened. Open a new ticket and mention its number.");
    if (action === "close" && !view.permissions.canClose) throw new HttpError(400, "Only a resolved ticket can be closed.");
    const to = action === "reopen" ? "open" : "closed";
    const now = nowIso();
    transaction(db, () => {
      writeUpdates(db, ticket.id, applyStatus(db, ticket, to, actor, now));
      recordEvent(db, ticket.id, actor.id, ticket.status, to, action === "reopen" ? "Reopened by the customer" : "Closed by the customer");
      refreshBreaches(db, ticket.id);
      audit(db, actor.id, `ticket.${action}`, "ticket", ticket.id, ticket.organization_id, null, actor.ip);
      if (action === "reopen") {
        notifyUsers(db, ticket.assigned_to ? [ticket.assigned_to] : staffIds(db), { title: `${ticket.number} was reopened`, body: ticket.title, kind: "ticket", link: `tickets/${ticket.id}` });
      }
    });
    return detail(db, actor, ticket.id);
  };
}

function sniff(buffer, declared) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: ".png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", ext: ".jpg" };
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: ".pdf" };
  if (declared === "text/plain" && !buffer.includes(0)) {
    const text = buffer.toString("utf8");
    if (!text.includes("\uFFFD")) return { mime: "text/plain", ext: ".txt" };
  }
  return null;
}

export function uploadsDir() {
  return path.resolve(process.env.DATA_DIR || "data", "uploads");
}

function upload({ db, actor, params, raw, req }) {
  const ticket = loadTicket(db, actor, params.id);
  if (ticket.status === "closed") throw new HttpError(400, "Attachments cannot be added to a closed ticket.");
  if (!raw?.length) throw new HttpError(400, "Choose a file to upload.");
  const declared = String(req.headers["content-type"] || "").split(";")[0].trim();
  const kind = sniff(raw, declared);
  if (!kind) throw new HttpError(415, "Upload a PNG, JPEG, PDF or plain-text file.");
  let original;
  try {
    original = decodeURIComponent(String(req.headers["x-file-name"] || "attachment"));
  } catch {
    original = "attachment";
  }
  original = path.basename(original).replace(/[^\w .()-]/g, "_").slice(0, 120) || "attachment";
  const visibility = isStaff(actor) && req.headers["x-visibility"] === "internal" ? "internal" : "customer";
  const count = db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE ticket_id = ?").get(ticket.id).n;
  if (count >= 20) throw new HttpError(400, "A ticket can have at most 20 attachments.");
  const stored = `${randomBytes(16).toString("hex")}${kind.ext}`;
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, stored), raw, { mode: 0o600, flag: "wx" });
  try {
    const info = db.prepare(`
      INSERT INTO attachments (ticket_id, uploaded_by, original_name, stored_name, mime, size, sha256, visibility, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ticket.id, actor.id, original, stored, kind.mime, raw.length, createHash("sha256").update(raw).digest("hex"), visibility, nowIso());
    audit(db, actor.id, "attachment.upload", "attachment", info.lastInsertRowid, ticket.organization_id, { ticket: ticket.id, size: raw.length, mime: kind.mime }, actor.ip);
  } catch (error) {
    fs.rmSync(path.join(dir, stored), { force: true });
    throw error;
  }
  return reply(201, detail(db, actor, ticket.id));
}

function download({ db, actor, params, res }) {
  const file = db.prepare("SELECT * FROM attachments WHERE id = ?").get(params.id);
  if (!file) throw new HttpError(404, "Not found.");
  loadTicket(db, actor, file.ticket_id);
  if (file.visibility === "internal" && !isStaff(actor)) throw new HttpError(404, "Not found.");
  const full = path.join(uploadsDir(), path.basename(file.stored_name));
  if (!fs.existsSync(full)) throw new HttpError(410, "The stored file is missing.");
  audit(db, actor.id, "attachment.download", "attachment", file.id, null, null, actor.ip);
  sendFile(res, { body: fs.readFileSync(full), type: file.mime, filename: file.original_name, inline: false });
}

export const routes = [
  ["GET", "/api/tickets", list],
  ["POST", "/api/tickets", create],
  ["GET", "/api/tickets/:id", ({ db, actor, params }) => detail(db, actor, params.id)],
  ["PATCH", "/api/tickets/:id", update],
  ["POST", "/api/tickets/:id/notes", addNote],
  ["POST", "/api/tickets/:id/reopen", customerAction("reopen")],
  ["POST", "/api/tickets/:id/close", customerAction("close")],
  ["POST", "/api/tickets/:id/attachments", upload, { raw: MAX_UPLOAD }],
  ["GET", "/api/attachments/:id", download],
];
