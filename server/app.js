import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupDatabase } from "./backup.js";
import { applyDeviceCheck } from "./checks.js";
import { assertHost } from "./probe.js";
import { audit, notify, notifyOrganization, notifyStaff } from "./db.js";
import { HttpError } from "./errors.js";
import { clientIp, readCookie, readJson, securityHeaders, sendJson, serveStatic, sessionCookie } from "./http.js";
import { buildPdf } from "./pdf.js";
import { hashPassword, passwordOk, randomId, tokensMatch } from "./security.js";
import {
  assertDate,
  assertEmail,
  assertEnum,
  assertInt,
  assertPassword,
  assertText,
  likePattern,
  nowIso,
  optionalText,
  pageParams,
  todayUtc,
} from "./validate.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const PRIORITIES = ["low", "normal", "high", "urgent"];
const STATUSES = ["open", "assigned", "in_progress", "resolved", "closed"];
const METHODS = ["cash", "bank_transfer", "other"];
const SESSION_SECONDS = 12 * 60 * 60;

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    organizationId: row.organization_id ?? row.organizationId ?? null,
  };
}

function mapOrg(row) {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone || "",
    location: row.location || "",
    status: row.status,
    planId: row.plan_id,
    planName: row.plan_name || "",
    priceUgx: row.price_ugx ?? null,
    deviceLimit: row.device_limit ?? null,
    supportHours: row.support_hours ?? null,
    responseTargetHours: row.response_target_hours ?? null,
    subscriptionStatus: row.subscription_status,
    renewalDate: row.renewal_date,
    createdAt: row.created_at,
  };
}

function mapPlan(row) {
  return {
    id: row.id,
    name: row.name,
    priceUgx: row.price_ugx,
    deviceLimit: row.device_limit,
    supportHours: row.support_hours,
    responseTargetHours: row.response_target_hours,
    description: row.description,
    active: row.active === 1,
  };
}

function mapDevice(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name || "",
    name: row.name,
    operatingSystem: row.operating_system || "",
    address: row.address || "",
    checkPort: row.check_port,
    reachability: row.reachability || "unknown",
    lastConnection: row.last_connection,
    lastChecked: row.last_checked,
    managementStatus: row.management_status,
    consentAt: row.consent_at,
    createdAt: row.created_at,
  };
}

function mapTicket(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name || "",
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    createdBy: row.created_by,
    creatorName: row.creator_name || "",
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name || "",
    resolutionSummary: row.resolution_summary || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function mapNote(row) {
  return {
    id: row.id,
    authorName: row.author_name,
    body: row.body,
    visibility: row.visibility,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

const ORG_SELECT = `
  SELECT o.*, p.name AS plan_name, p.price_ugx, p.device_limit, p.support_hours, p.response_target_hours
  FROM organizations o
  LEFT JOIN service_plans p ON p.id = o.plan_id
`;

function needsSetup(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0;
}

function loadSession(db, req) {
  const sid = readCookie(req, "osvia_session");
  if (!sid) return null;
  const row = db.prepare(`
    SELECT s.id AS session_id, s.csrf_token, s.expires_at, u.id, u.name, u.email, u.role, u.organization_id, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sid);
  if (!row || row.active !== 1 || row.expires_at < nowIso()) return null;
  return { ...publicUser(row), csrfToken: row.csrf_token, sessionId: row.session_id };
}

function requireUser(db, req) {
  const user = loadSession(db, req);
  if (!user) throw new HttpError(401, "Sign in required.");
  return user;
}

function requireCsrf(req, user) {
  if (!tokensMatch(req.headers["x-csrf-token"], user.csrfToken)) {
    throw new HttpError(403, "Refresh the page and try again.");
  }
}

function requireStaff(user) {
  if (user.role === "customer") throw new HttpError(403, "This action is limited to OSVIA staff.");
}

function requireAdmin(user) {
  if (user.role !== "admin") throw new HttpError(403, "This action is limited to an administrator.");
}

function orgIdFor(user, requested) {
  if (user.role === "customer") return user.organizationId;
  const id = Number(requested);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "Choose an organization.");
  return id;
}

function mustOrg(db, id) {
  const row = db.prepare(`${ORG_SELECT} WHERE o.id = ?`).get(id);
  if (!row) throw new HttpError(404, "Organization not found.");
  return row;
}

function assertOrgAccess(user, organizationId) {
  if (user.role === "customer" && user.organizationId !== organizationId) throw new HttpError(404, "Not found.");
}

function tooMany(db, bucket, limit, minutes) {
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  return db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE bucket = ? AND attempted_at >= ?").get(bucket, since).n >= limit;
}

function recordAttempt(db, bucket) {
  const now = nowIso();
  db.prepare("INSERT INTO login_attempts (bucket, attempted_at) VALUES (?, ?)").run(bucket, now);
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < ?").run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
}

function createSession(db, userId) {
  const id = randomId();
  const csrfToken = randomId(24);
  const created = nowIso();
  const expires = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, csrfToken, expires, created);
  return { id, csrfToken };
}

function sessionResponse(res, db, userId) {
  const session = createSession(db, userId);
  const user = db.prepare("SELECT id, name, email, role, organization_id FROM users WHERE id = ?").get(userId);
  sendJson(res, 200, { user: publicUser(user), csrfToken: session.csrfToken }, { "Set-Cookie": sessionCookie(session.id, SESSION_SECONDS) });
}

function uniqueOrThrow(error) {
  if (/UNIQUE/i.test(error.message || "")) throw new HttpError(409, "An account with that email already exists.");
  throw error;
}

function transaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already closed */ }
    throw error;
  }
}

function setup(db, res, body) {
  if (!needsSetup(db)) throw new HttpError(403, "The administrator account already exists.");
  const name = assertText(body.name, "Name", 120);
  const email = assertEmail(body.email);
  const password = assertPassword(body.password);
  const userId = transaction(db, () => {
    const info = db.prepare("INSERT INTO users (name, email, password_hash, role, active, created_at) VALUES (?, ?, ?, 'admin', 1, ?)").run(name, email, hashPassword(password), nowIso());
    audit(db, Number(info.lastInsertRowid), "admin.setup", "user", info.lastInsertRowid, null, null);
    return Number(info.lastInsertRowid);
  });
  sessionResponse(res, db, userId);
}

function login(db, req, res, body) {
  const email = assertEmail(body.email);
  const password = String(body.password || "");
  const ip = clientIp(req);
  const bucket = `login:${ip}|${email}`;
  if (tooMany(db, bucket, 8, 15) || tooMany(db, `ip:${ip}`, 40, 15)) {
    throw new HttpError(429, "Too many sign-in attempts. Wait 15 minutes and try again.");
  }
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const passwordMatches = passwordOk(password, user?.password_hash);
  if (!user || user.active !== 1 || !passwordMatches) {
    recordAttempt(db, bucket);
    recordAttempt(db, `ip:${ip}`);
    audit(db, null, "login.failed", "session", null, null, { email });
    throw new HttpError(401, "Email or password is incorrect.");
  }
  db.prepare("DELETE FROM login_attempts WHERE bucket = ? OR bucket = ?").run(bucket, `ip:${ip}`);
  audit(db, user.id, "login.succeeded", "session", null, user.organization_id, null);
  sessionResponse(res, db, user.id);
}

function register(db, req, res, body) {
  if (needsSetup(db)) throw new HttpError(400, "Create the administrator account first.");
  const ip = clientIp(req);
  if (tooMany(db, `register:${ip}`, 10, 60)) throw new HttpError(429, "Too many registration attempts. Wait and try again.");
  recordAttempt(db, `register:${ip}`);
  const organizationName = assertText(body.organizationName, "Organization name", 160);
  const contactName = assertText(body.contactName, "Contact name", 120);
  const email = assertEmail(body.email);
  const phone = optionalText(body.phone, 40);
  const location = optionalText(body.location, 160);
  const password = assertPassword(body.password);
  try {
    transaction(db, () => {
      const org = db.prepare(`
        INSERT INTO organizations (name, contact_name, contact_email, contact_phone, location, status, subscription_status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 'unpaid', ?)
      `).run(organizationName, contactName, email, phone, location, nowIso());
      const user = db.prepare(`
        INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at)
        VALUES (?, ?, ?, ?, 'customer', 1, ?)
      `).run(Number(org.lastInsertRowid), contactName, email, hashPassword(password), nowIso());
      audit(db, Number(user.lastInsertRowid), "organization.register", "organization", org.lastInsertRowid, Number(org.lastInsertRowid), null);
    });
  } catch (error) {
    uniqueOrThrow(error);
  }
  notifyStaff(db, "New organization", `${organizationName} registered and is waiting for subscription confirmation.`);
  sendJson(res, 201, { ok: true });
}

function createOrganization(db, user, res, body) {
  requireStaff(user);
  const name = assertText(body.name, "Organization name", 160);
  const contactName = assertText(body.contactName, "Contact name", 120);
  const contactEmail = assertEmail(body.contactEmail);
  const info = db.prepare(`
    INSERT INTO organizations (name, contact_name, contact_email, contact_phone, location, status, subscription_status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 'unpaid', ?)
  `).run(name, contactName, contactEmail, optionalText(body.contactPhone, 40), optionalText(body.location, 160), nowIso());
  audit(db, user.id, "organization.create", "organization", info.lastInsertRowid, Number(info.lastInsertRowid), null);
  sendJson(res, 201, { organization: mapOrg(mustOrg(db, Number(info.lastInsertRowid))) });
}

function listOrganizations(db, user, url) {
  const { page, limit, offset, q } = pageParams(url);
  const where = [];
  const args = [];
  if (user.role === "customer") {
    where.push("o.id = ?");
    args.push(user.organizationId);
  } else if (q) {
    where.push(`(o.name LIKE ? ESCAPE '\\' OR o.contact_email LIKE ? ESCAPE '\\')`);
    args.push(likePattern(q), likePattern(q));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM organizations o ${clause}`).get(...args).n;
  const items = db.prepare(`${ORG_SELECT} ${clause} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(mapOrg);
  return { items, page, pageSize: limit, total };
}

function createUser(db, actor, res, body) {
  requireStaff(actor);
  const role = assertEnum(body.role, ["customer", "technician"], "role");
  if (role === "technician") requireAdmin(actor);
  const name = assertText(body.name, "Name", 120);
  const email = assertEmail(body.email);
  const password = assertPassword(body.password);
  let organizationId = null;
  if (role === "customer") {
    organizationId = orgIdFor(actor, body.organizationId);
    mustOrg(db, organizationId);
  }
  let userId;
  try {
    const info = db.prepare(`
      INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(organizationId, name, email, hashPassword(password), role, nowIso());
    userId = Number(info.lastInsertRowid);
  } catch (error) {
    uniqueOrThrow(error);
  }
  audit(db, actor.id, "user.create", "user", userId, organizationId, { role });
  const created = db.prepare("SELECT id, name, email, role, organization_id, active FROM users WHERE id = ?").get(userId);
  sendJson(res, 201, { user: { ...publicUser(created), active: created.active === 1 } });
}

function listUsers(db, actor, url) {
  const { page, limit, offset } = pageParams(url);
  const where = [];
  const args = [];
  if (actor.role === "customer") {
    where.push("organization_id = ?");
    args.push(actor.organizationId);
  } else {
    const requested = url.searchParams.get("organizationId");
    if (requested) {
      where.push("organization_id = ?");
      args.push(orgIdFor(actor, requested));
    }
    const role = url.searchParams.get("role");
    if (role === "staff") where.push("role IN ('admin', 'technician')");
    else if (role) {
      where.push("role = ?");
      args.push(assertEnum(role, ["admin", "technician", "customer"], "role"));
    }
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users ${clause}`).get(...args).n;
  const items = db.prepare(`
    SELECT id, name, email, role, organization_id, active, created_at
    FROM users ${clause} ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset).map((row) => ({ ...publicUser(row), active: row.active === 1, createdAt: row.created_at }));
  return { items, page, pageSize: limit, total };
}

function setUserActive(db, actor, res, userId, body) {
  requireAdmin(actor);
  if (userId === actor.id) throw new HttpError(400, "You cannot disable your own account.");
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!target) throw new HttpError(404, "User not found.");
  const active = body.active === true || body.active === 1 ? 1 : 0;
  if (target.role === "admin" && active === 0) {
    const count = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
    if (count <= 1) throw new HttpError(400, "Keep at least one active administrator.");
  }
  db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active, userId);
  if (active === 0) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  audit(db, actor.id, active ? "user.enabled" : "user.disabled", "user", userId, target.organization_id, null);
  sendJson(res, 200, { ok: true });
}

function deviceLimit(db, organizationId) {
  const org = mustOrg(db, organizationId);
  const limit = org.device_limit || 5;
  const count = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE organization_id = ?").get(organizationId).n;
  if (count >= limit) throw new HttpError(400, `This organization can register ${limit} devices on the current plan.`);
}

async function createDevice(db, actor, res, body) {
  const organizationId = orgIdFor(actor, body.organizationId);
  mustOrg(db, organizationId);
  deviceLimit(db, organizationId);
  const name = assertText(body.name, "Device name", 120);
  const operatingSystem = optionalText(body.operatingSystem, 80);
  const address = assertHost(body.address);
  const checkPort = body.checkPort === undefined || body.checkPort === "" || body.checkPort === null
    ? null
    : assertInt(body.checkPort, "Port", 1, 65535);
  const info = db.prepare(`
    INSERT INTO devices (organization_id, name, operating_system, address, check_port, reachability, last_connection, management_status, created_at)
    VALUES (?, ?, ?, ?, ?, 'unknown', NULL, 'not_connected', ?)
  `).run(organizationId, name, operatingSystem, address || null, checkPort, nowIso());
  const deviceId = Number(info.lastInsertRowid);
  audit(db, actor.id, "device.create", "device", deviceId, organizationId, address ? { address, checkPort } : null);
  const row = address ? await applyDeviceCheck(db, deviceId) : db.prepare(`
    SELECT d.*, o.name AS organization_name FROM devices d JOIN organizations o ON o.id = d.organization_id WHERE d.id = ?
  `).get(deviceId);
  sendJson(res, 201, { device: mapDevice(row) });
}

function listDevices(db, actor, url) {
  const { page, limit, offset, q } = pageParams(url);
  const where = [];
  const args = [];
  if (actor.role === "customer") {
    where.push("d.organization_id = ?");
    args.push(actor.organizationId);
  } else if (url.searchParams.get("organizationId")) {
    const organizationId = orgIdFor(actor, url.searchParams.get("organizationId"));
    mustOrg(db, organizationId);
    where.push("d.organization_id = ?");
    args.push(organizationId);
  }
  if (q) {
    where.push(`(d.name LIKE ? ESCAPE '\\' OR d.operating_system LIKE ? ESCAPE '\\')`);
    args.push(likePattern(q), likePattern(q));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM devices d ${clause}`).get(...args).n;
  const items = db.prepare(`
    SELECT d.*, o.name AS organization_name
    FROM devices d JOIN organizations o ON o.id = d.organization_id
    ${clause} ORDER BY d.id DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset).map(mapDevice);
  return { items, page, pageSize: limit, total };
}

async function recheckDevice(db, actor, res, deviceId) {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId);
  if (!device) throw new HttpError(404, "Not found.");
  assertOrgAccess(actor, device.organization_id);
  if (!device.address) throw new HttpError(400, "Add an IP address or hostname before checking this device.");
  const row = await applyDeviceCheck(db, deviceId);
  audit(db, actor.id, "device.check", "device", deviceId, device.organization_id, { reachability: row.reachability });
  sendJson(res, 200, { device: mapDevice(row) });
}

function consentDevice(db, actor, res, deviceId) {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId);
  if (!device) throw new HttpError(404, "Not found.");
  assertOrgAccess(actor, device.organization_id);
  const consentAt = nowIso();
  db.prepare("UPDATE devices SET management_status = 'consent_recorded', consent_at = ? WHERE id = ?").run(consentAt, deviceId);
  audit(db, actor.id, "device.consent", "device", deviceId, device.organization_id, null);
  sendJson(res, 200, { ok: true, managementStatus: "consent_recorded", lastConnection: null });
}

function createTicket(db, actor, res, body) {
  const organizationId = orgIdFor(actor, body.organizationId);
  mustOrg(db, organizationId);
  const title = assertText(body.title, "Title", 160);
  const description = assertText(body.description, "Description", 5000);
  const priority = assertEnum(body.priority || "normal", PRIORITIES, "priority");
  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO tickets (organization_id, created_by, title, description, priority, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(organizationId, actor.id, title, description, priority, now, now);
  audit(db, actor.id, "ticket.create", "ticket", info.lastInsertRowid, organizationId, { priority });
  notifyStaff(db, `Ticket #${info.lastInsertRowid}`, title);
  sendJson(res, 201, { ticket: mapTicket(loadTicketRow(db, Number(info.lastInsertRowid))) });
}

function loadTicketRow(db, id) {
  return db.prepare(`
    SELECT t.*, o.name AS organization_name, c.name AS creator_name, a.name AS assignee_name
    FROM tickets t
    JOIN organizations o ON o.id = t.organization_id
    JOIN users c ON c.id = t.created_by
    LEFT JOIN users a ON a.id = t.assigned_to
    WHERE t.id = ?
  `).get(id);
}

function listTickets(db, actor, url) {
  const { page, limit, offset, q } = pageParams(url);
  const where = [];
  const args = [];
  if (actor.role === "customer") {
    where.push("t.organization_id = ?");
    args.push(actor.organizationId);
  } else if (url.searchParams.get("organizationId")) {
    where.push("t.organization_id = ?");
    args.push(orgIdFor(actor, url.searchParams.get("organizationId")));
  }
  const status = url.searchParams.get("status");
  if (status) {
    where.push("t.status = ?");
    args.push(assertEnum(status, STATUSES, "status"));
  }
  const priority = url.searchParams.get("priority");
  if (priority) {
    where.push("t.priority = ?");
    args.push(assertEnum(priority, PRIORITIES, "priority"));
  }
  if (q) {
    where.push(`(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')`);
    args.push(likePattern(q), likePattern(q));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${clause}`).get(...args).n;
  const items = db.prepare(`
    SELECT t.*, o.name AS organization_name, c.name AS creator_name, a.name AS assignee_name
    FROM tickets t
    JOIN organizations o ON o.id = t.organization_id
    JOIN users c ON c.id = t.created_by
    LEFT JOIN users a ON a.id = t.assigned_to
    ${clause}
    ORDER BY t.id DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset).map(mapTicket);
  return { items, page, pageSize: limit, total };
}

function getTicket(db, actor, id) {
  const row = loadTicketRow(db, id);
  if (!row) throw new HttpError(404, "Not found.");
  assertOrgAccess(actor, row.organization_id);
  const visibility = actor.role === "customer" ? "AND n.visibility = 'customer'" : "";
  const notes = db.prepare(`
    SELECT n.*, u.name AS author_name
    FROM ticket_notes n JOIN users u ON u.id = n.author_id
    WHERE n.ticket_id = ? ${visibility}
    ORDER BY n.id
  `).all(id).map(mapNote);
  return { ticket: mapTicket(row), notes };
}

function updateTicket(db, actor, res, id, body) {
  requireStaff(actor);
  const row = loadTicketRow(db, id);
  if (!row) throw new HttpError(404, "Not found.");
  const status = body.status ? assertEnum(body.status, STATUSES, "status") : row.status;
  const priority = body.priority ? assertEnum(body.priority, PRIORITIES, "priority") : row.priority;
  let assignedTo = row.assigned_to;
  if (Object.hasOwn(body, "assignedTo")) {
    if (body.assignedTo === null || body.assignedTo === "") assignedTo = null;
    else {
      assignedTo = assertInt(body.assignedTo, "Assignee", 1, 1_000_000_000);
      const assignee = db.prepare("SELECT id, role FROM users WHERE id = ? AND active = 1").get(assignedTo);
      if (!assignee || assignee.role === "customer") throw new HttpError(400, "Assign the ticket to an active technician or administrator.");
    }
  }
  let summary = row.resolution_summary;
  if (Object.hasOwn(body, "resolutionSummary")) summary = optionalText(body.resolutionSummary, 5000);
  if ((status === "resolved" || status === "closed") && !summary) {
    throw new HttpError(400, "Add a resolution summary before resolving the ticket.");
  }
  const resolvedAt = row.resolved_at || (status === "resolved" || status === "closed" ? nowIso() : null);
  db.prepare(`
    UPDATE tickets
    SET status = ?, priority = ?, assigned_to = ?, resolution_summary = ?, updated_at = ?, resolved_at = ?
    WHERE id = ?
  `).run(status, priority, assignedTo, summary, nowIso(), resolvedAt, id);
  audit(db, actor.id, "ticket.update", "ticket", id, row.organization_id, { status, priority });
  notify(db, row.created_by, `Ticket #${id} updated`, `Status is now ${status.replaceAll("_", " ")}.`);
  if (assignedTo) notify(db, assignedTo, `Ticket #${id} assigned`, row.title);
  sendJson(res, 200, getTicket(db, actor, id));
}

function addNote(db, actor, res, id, body) {
  const row = loadTicketRow(db, id);
  if (!row) throw new HttpError(404, "Not found.");
  assertOrgAccess(actor, row.organization_id);
  const text = assertText(body.body, "Note", 5000);
  const kind = actor.role === "customer" ? "comment" : assertEnum(body.kind || "comment", ["comment", "work_log"], "note type");
  const visibility = actor.role === "customer" ? "customer" : assertEnum(body.visibility || "customer", ["customer", "internal"], "visibility");
  const info = db.prepare(`
    INSERT INTO ticket_notes (ticket_id, author_id, body, visibility, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, actor.id, text, visibility, kind, nowIso());
  db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(nowIso(), id);
  audit(db, actor.id, "ticket.note", "ticket", id, row.organization_id, { visibility, kind });
  if (visibility === "customer" && actor.id !== row.created_by) {
    notify(db, row.created_by, `New note on ticket #${id}`, text.slice(0, 180));
  }
  if (actor.role === "customer") notifyStaff(db, `Customer note on ticket #${id}`, text.slice(0, 180));
  sendJson(res, 201, { id: Number(info.lastInsertRowid) });
}

function listPlans(db) {
  return db.prepare("SELECT * FROM service_plans ORDER BY price_ugx").all().map(mapPlan);
}

function updatePlan(db, actor, res, id, body) {
  requireAdmin(actor);
  const current = db.prepare("SELECT * FROM service_plans WHERE id = ?").get(id);
  if (!current) throw new HttpError(404, "Plan not found.");
  const name = assertText(body.name ?? current.name, "Plan name", 80);
  const priceUgx = assertInt(body.priceUgx ?? current.price_ugx, "Price", 0, 1_000_000_000);
  const deviceLimitValue = assertInt(body.deviceLimit ?? current.device_limit, "Device limit", 1, 100_000);
  const supportHours = assertInt(body.supportHours ?? current.support_hours, "Support hours", 0, 10_000);
  const responseTargetHours = assertInt(body.responseTargetHours ?? current.response_target_hours, "Response target", 1, 720);
  const description = assertText(body.description ?? current.description, "Description", 500);
  const active = body.active === undefined ? current.active : (body.active ? 1 : 0);
  db.prepare(`
    UPDATE service_plans
    SET name = ?, price_ugx = ?, device_limit = ?, support_hours = ?, response_target_hours = ?, description = ?, active = ?
    WHERE id = ?
  `).run(name, priceUgx, deviceLimitValue, supportHours, responseTargetHours, description, active, id);
  audit(db, actor.id, "plan.update", "plan", id, null, { priceUgx });
  sendJson(res, 200, { plan: mapPlan(db.prepare("SELECT * FROM service_plans WHERE id = ?").get(id)) });
}

function recordPayment(db, actor, res, body) {
  requireStaff(actor);
  const organizationId = orgIdFor(actor, body.organizationId);
  mustOrg(db, organizationId);
  const amount = assertInt(body.amountUgx, "Amount", 1, 1_000_000_000);
  const method = assertEnum(body.method, METHODS, "payment method");
  const reference = assertText(body.reference, "Reference", 120);
  const note = optionalText(body.note, 500);
  const info = db.prepare(`
    INSERT INTO payments (organization_id, amount_ugx, method, reference, note, status, recorded_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?)
  `).run(organizationId, amount, method, reference, note, actor.id, nowIso());
  audit(db, actor.id, "payment.record", "payment", info.lastInsertRowid, organizationId, { amount, method });
  sendJson(res, 201, { payment: mapPayment(db.prepare("SELECT * FROM payments WHERE id = ?").get(Number(info.lastInsertRowid))) });
}

function mapPayment(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    amountUgx: row.amount_ugx,
    method: row.method,
    reference: row.reference,
    note: row.note || "",
    status: row.status,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  };
}

function listPayments(db, actor, url) {
  const { page, limit, offset } = pageParams(url);
  const where = [];
  const args = [];
  if (actor.role === "customer") {
    where.push("organization_id = ?");
    args.push(actor.organizationId);
  } else if (url.searchParams.get("organizationId")) {
    where.push("organization_id = ?");
    args.push(orgIdFor(actor, url.searchParams.get("organizationId")));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM payments ${clause}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM payments ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(mapPayment);
  return { items, page, pageSize: limit, total };
}

function confirmPayment(db, actor, res, id) {
  requireAdmin(actor);
  const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
  if (!payment) throw new HttpError(404, "Payment not found.");
  if (payment.status === "confirmed") throw new HttpError(400, "This payment is already confirmed.");
  const confirmedAt = nowIso();
  db.prepare("UPDATE payments SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ?").run(actor.id, confirmedAt, id);
  audit(db, actor.id, "payment.confirm", "payment", id, payment.organization_id, null);
  notifyOrganization(db, payment.organization_id, "Payment confirmed", `A payment of UGX ${payment.amount_ugx} was confirmed. The subscription is active only after an administrator activates it.`);
  sendJson(res, 200, { payment: mapPayment(db.prepare("SELECT * FROM payments WHERE id = ?").get(id)) });
}

function activateSubscription(db, actor, res, organizationId, body) {
  requireAdmin(actor);
  const org = mustOrg(db, organizationId);
  const planId = assertInt(body.planId, "Plan", 1, 1_000_000_000);
  const plan = db.prepare("SELECT * FROM service_plans WHERE id = ? AND active = 1").get(planId);
  if (!plan) throw new HttpError(400, "Choose an active service plan.");
  const payment = db.prepare("SELECT id FROM payments WHERE organization_id = ? AND status = 'confirmed' LIMIT 1").get(organizationId);
  if (!payment) throw new HttpError(400, "Confirm a payment before activating the subscription.");
  const renewal = todayUtc(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
  db.prepare(`
    UPDATE organizations
    SET plan_id = ?, subscription_status = 'active', status = 'active', renewal_date = ?
    WHERE id = ?
  `).run(planId, renewal, organizationId);
  audit(db, actor.id, "subscription.activate", "organization", organizationId, organizationId, { planId, renewal });
  notifyOrganization(db, organizationId, "Subscription active", `${org.name} is on the ${plan.name} plan until ${renewal}.`);
  sendJson(res, 200, { organization: mapOrg(mustOrg(db, organizationId)) });
}

function createMaintenance(db, actor, res, body) {
  requireStaff(actor);
  const organizationId = orgIdFor(actor, body.organizationId);
  mustOrg(db, organizationId);
  let deviceId = null;
  if (body.deviceId) {
    deviceId = assertInt(body.deviceId, "Device", 1, 1_000_000_000);
    const device = db.prepare("SELECT id FROM devices WHERE id = ? AND organization_id = ?").get(deviceId, organizationId);
    if (!device) throw new HttpError(400, "That device is not registered to this organization.");
  }
  const summary = assertText(body.summary, "Summary", 5000);
  const performedAt = assertDate(body.performedAt, "Date");
  const info = db.prepare(`
    INSERT INTO maintenance_records (organization_id, device_id, technician_id, summary, performed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(organizationId, deviceId, actor.id, summary, performedAt, nowIso());
  audit(db, actor.id, "maintenance.create", "maintenance", info.lastInsertRowid, organizationId, null);
  notifyOrganization(db, organizationId, "Maintenance recorded", summary.slice(0, 180));
  sendJson(res, 201, { id: Number(info.lastInsertRowid) });
}

function maintenanceReport(db, actor, organizationId) {
  assertOrgAccess(actor, organizationId);
  const org = mustOrg(db, organizationId);
  const records = db.prepare(`
    SELECT m.*, d.name AS device_name, u.name AS technician_name
    FROM maintenance_records m
    LEFT JOIN devices d ON d.id = m.device_id
    JOIN users u ON u.id = m.technician_id
    WHERE m.organization_id = ?
    ORDER BY m.performed_at DESC, m.id DESC
  `).all(organizationId);
  const tickets = db.prepare(`
    SELECT id, title, status, priority, created_at, resolved_at, resolution_summary
    FROM tickets WHERE organization_id = ? ORDER BY id DESC
  `).all(organizationId);
  return {
    organization: mapOrg(org),
    records: records.map((row) => ({
      id: row.id,
      deviceName: row.device_name || "",
      technicianName: row.technician_name,
      summary: row.summary,
      performedAt: row.performed_at,
    })),
    tickets: tickets.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolutionSummary: row.resolution_summary || "",
    })),
  };
}

function createSchedule(db, actor, res, body) {
  requireStaff(actor);
  const organizationId = orgIdFor(actor, body.organizationId);
  mustOrg(db, organizationId);
  const title = assertText(body.title, "Title", 160);
  const nextDue = assertDate(body.nextDue, "Next due date");
  const intervalDays = body.intervalDays ? assertInt(body.intervalDays, "Interval", 1, 3650) : null;
  const notes = optionalText(body.notes, 1000);
  const info = db.prepare(`
    INSERT INTO maintenance_schedules (organization_id, title, next_due, interval_days, notes, active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(organizationId, title, nextDue, intervalDays, notes, nowIso());
  audit(db, actor.id, "schedule.create", "schedule", info.lastInsertRowid, organizationId, null);
  sendJson(res, 201, { id: Number(info.lastInsertRowid) });
}

function listSchedules(db, actor, url) {
  const organizationId = actor.role === "customer" ? actor.organizationId : (url.searchParams.get("organizationId") ? orgIdFor(actor, url.searchParams.get("organizationId")) : null);
  if (actor.role === "customer") assertOrgAccess(actor, organizationId);
  const args = [];
  let clause = "";
  if (organizationId) {
    clause = "WHERE s.organization_id = ?";
    args.push(organizationId);
  } else {
    requireStaff(actor);
  }
  const items = db.prepare(`
    SELECT s.*, o.name AS organization_name
    FROM maintenance_schedules s JOIN organizations o ON o.id = s.organization_id
    ${clause}
    ORDER BY s.next_due
  `).all(...args).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    title: row.title,
    nextDue: row.next_due,
    intervalDays: row.interval_days,
    notes: row.notes || "",
    active: row.active === 1,
  }));
  return { items };
}

function dashboard(db, actor) {
  if (actor.role === "customer") {
    const org = actor.organizationId ? mustOrg(db, actor.organizationId) : null;
    return {
      role: actor.role,
      openTickets: db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE organization_id = ? AND status IN ('open', 'assigned', 'in_progress')").get(actor.organizationId).n,
      devices: db.prepare("SELECT COUNT(*) AS n FROM devices WHERE organization_id = ?").get(actor.organizationId).n,
      onlineDevices: db.prepare("SELECT COUNT(*) AS n FROM devices WHERE organization_id = ? AND reachability = 'online'").get(actor.organizationId).n,
      offlineDevices: db.prepare("SELECT COUNT(*) AS n FROM devices WHERE organization_id = ? AND reachability = 'offline'").get(actor.organizationId).n,
      unread: db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(actor.id).n,
      organization: org ? mapOrg(org) : null,
      recentTickets: db.prepare(`
        SELECT t.*, o.name AS organization_name, c.name AS creator_name, a.name AS assignee_name
        FROM tickets t
        JOIN organizations o ON o.id = t.organization_id
        JOIN users c ON c.id = t.created_by
        LEFT JOIN users a ON a.id = t.assigned_to
        WHERE t.organization_id = ?
        ORDER BY t.id DESC LIMIT 5
      `).all(actor.organizationId).map(mapTicket),
      remoteManagement: "not_connected",
    };
  }
  const hours = db.prepare(`
    SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24.0) AS hours
    FROM tickets WHERE resolved_at IS NOT NULL
  `).get().hours;
  return {
    role: actor.role,
    organizations: db.prepare("SELECT COUNT(*) AS n FROM organizations").get().n,
    openTickets: db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status IN ('open', 'assigned', 'in_progress')").get().n,
    devices: db.prepare("SELECT COUNT(*) AS n FROM devices").get().n,
    onlineDevices: db.prepare("SELECT COUNT(*) AS n FROM devices WHERE reachability = 'online'").get().n,
    offlineDevices: db.prepare("SELECT COUNT(*) AS n FROM devices WHERE reachability = 'offline'").get().n,
    unpaid: db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE subscription_status != 'active'").get().n,
    averageResolutionHours: hours == null ? null : Math.round(hours * 10) / 10,
    unread: db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(actor.id).n,
    remoteManagement: "not_connected",
  };
}

function serviceStatus(db, actor) {
  const base = {
    desk: "available",
    remoteManagement: "not_connected",
    detail: "Online and offline come from a ping or port check to each device address. Remote desktop through MeshCentral is not connected.",
  };
  if (actor.role === "customer" && actor.organizationId) {
    const org = mustOrg(db, actor.organizationId);
    return { ...base, organizationStatus: org.status, subscriptionStatus: org.subscription_status, renewalDate: org.renewal_date };
  }
  return base;
}

function idFrom(pathname, prefix) {
  const match = pathname.match(prefix);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "Invalid id.");
  return id;
}

async function dispatch(db, req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const { pathname } = url;
  const method = req.method || "GET";

  if (method === "GET" && !pathname.startsWith("/api/")) return serveStatic(res, PUBLIC_DIR, pathname);

  if (method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, needsSetup: needsSetup(db), remoteManagement: "not_connected" });
  }
  if (method === "GET" && pathname === "/api/public-config") {
    return sendJson(res, 200, {
      product: "OSVIA BUSINESS CARE",
      company: "OSVIA TECHNOLOGIES",
      location: "Kampala, Uganda",
      website: "https://osviatech.com",
      contactEmail: process.env.CONTACT_EMAIL || "",
      contactPhone: process.env.CONTACT_PHONE || "",
    });
  }

  const unsafe = method === "POST" || method === "PATCH" || method === "DELETE";
  const body = unsafe ? await readJson(req) : null;
  const publicPost = method === "POST" && ["/api/setup", "/api/login", "/api/register"].includes(pathname);

  if (publicPost && pathname === "/api/setup") return setup(db, res, body);
  if (publicPost && pathname === "/api/login") return login(db, req, res, body);
  if (publicPost && pathname === "/api/register") return register(db, req, res, body);

  const actor = requireUser(db, req);
  if (unsafe) requireCsrf(req, actor);

  if (method === "POST" && pathname === "/api/logout") {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(actor.sessionId);
    audit(db, actor.id, "logout", "session", null, actor.organizationId, null);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (method === "GET" && pathname === "/api/me") {
    return sendJson(res, 200, {
      user: { id: actor.id, name: actor.name, email: actor.email, role: actor.role, organizationId: actor.organizationId },
      csrfToken: actor.csrfToken,
    });
  }
  if (method === "GET" && pathname === "/api/dashboard") return sendJson(res, 200, dashboard(db, actor));
  if (method === "GET" && pathname === "/api/service-status") return sendJson(res, 200, serviceStatus(db, actor));

  if (method === "GET" && pathname === "/api/organizations") return sendJson(res, 200, listOrganizations(db, actor, url));
  if (method === "POST" && pathname === "/api/organizations") return createOrganization(db, actor, res, body);
  let id = idFrom(pathname, /^\/api\/organizations\/(\d+)$/);
  if (id && method === "GET") {
    const org = mustOrg(db, id);
    assertOrgAccess(actor, id);
    return sendJson(res, 200, { organization: mapOrg(org) });
  }
  id = idFrom(pathname, /^\/api\/organizations\/(\d+)\/subscription$/);
  if (id && method === "POST") return activateSubscription(db, actor, res, id, body);

  if (method === "POST" && pathname === "/api/users") return createUser(db, actor, res, body);
  if (method === "GET" && pathname === "/api/users") return sendJson(res, 200, listUsers(db, actor, url));
  id = idFrom(pathname, /^\/api\/users\/(\d+)$/);
  if (id && method === "PATCH") return setUserActive(db, actor, res, id, body);

  if (method === "GET" && pathname === "/api/devices") return sendJson(res, 200, listDevices(db, actor, url));
  if (method === "POST" && pathname === "/api/devices") return createDevice(db, actor, res, body);
  id = idFrom(pathname, /^\/api\/devices\/(\d+)\/check$/);
  if (id && method === "POST") return recheckDevice(db, actor, res, id);
  id = idFrom(pathname, /^\/api\/devices\/(\d+)\/consent$/);
  if (id && method === "POST") return consentDevice(db, actor, res, id);

  if (method === "GET" && pathname === "/api/tickets") return sendJson(res, 200, listTickets(db, actor, url));
  if (method === "POST" && pathname === "/api/tickets") return createTicket(db, actor, res, body);
  id = idFrom(pathname, /^\/api\/tickets\/(\d+)$/);
  if (id && method === "GET") return sendJson(res, 200, getTicket(db, actor, id));
  if (id && method === "PATCH") return updateTicket(db, actor, res, id, body);
  id = idFrom(pathname, /^\/api\/tickets\/(\d+)\/notes$/);
  if (id && method === "POST") return addNote(db, actor, res, id, body);

  if (method === "GET" && pathname === "/api/plans") return sendJson(res, 200, { items: listPlans(db) });
  id = idFrom(pathname, /^\/api\/plans\/(\d+)$/);
  if (id && method === "PATCH") return updatePlan(db, actor, res, id, body);

  if (method === "GET" && pathname === "/api/payments") return sendJson(res, 200, listPayments(db, actor, url));
  if (method === "POST" && pathname === "/api/payments") return recordPayment(db, actor, res, body);
  id = idFrom(pathname, /^\/api\/payments\/(\d+)\/confirm$/);
  if (id && method === "POST") return confirmPayment(db, actor, res, id);

  if (method === "GET" && pathname === "/api/maintenance") {
    const organizationId = orgIdFor(actor, url.searchParams.get("organizationId"));
    return sendJson(res, 200, maintenanceReport(db, actor, organizationId));
  }
  if (method === "POST" && pathname === "/api/maintenance") return createMaintenance(db, actor, res, body);
  if (method === "GET" && pathname === "/api/reports/maintenance.pdf") {
    const organizationId = orgIdFor(actor, url.searchParams.get("organizationId"));
    const report = maintenanceReport(db, actor, organizationId);
    const lines = [
      `${report.organization.name}`,
      `Subscription: ${report.organization.subscriptionStatus}`,
      `Generated: ${nowIso()}`,
      "",
      "Maintenance records",
    ];
    if (!report.records.length) lines.push("No maintenance records are stored for this organization.");
    for (const record of report.records) {
      lines.push(`${record.performedAt} ${record.deviceName || "Organization"} — ${record.summary} (${record.technicianName})`);
    }
    lines.push("", "Tickets");
    if (!report.tickets.length) lines.push("No tickets are stored for this organization.");
    for (const ticket of report.tickets) {
      lines.push(`#${ticket.id} [${ticket.status}] ${ticket.title}`);
    }
    const pdf = buildPdf("OSVIA Business Care maintenance report", lines);
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": pdf.length,
      "Content-Disposition": "attachment; filename=\"osvia-maintenance-report.pdf\"",
      "Cache-Control": "no-store",
      ...securityHeaders(),
    });
    res.end(pdf);
    return;
  }

  if (method === "GET" && pathname === "/api/schedules") return sendJson(res, 200, listSchedules(db, actor, url));
  if (method === "POST" && pathname === "/api/schedules") return createSchedule(db, actor, res, body);

  if (method === "GET" && pathname === "/api/notifications") {
    const items = db.prepare("SELECT id, title, body, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50").all(actor.id).map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      readAt: row.read_at,
      createdAt: row.created_at,
    }));
    return sendJson(res, 200, { items });
  }
  id = idFrom(pathname, /^\/api\/notifications\/(\d+)\/read$/);
  if (id && method === "POST") {
    const note = db.prepare("SELECT id FROM notifications WHERE id = ? AND user_id = ?").get(id, actor.id);
    if (!note) throw new HttpError(404, "Not found.");
    db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").run(nowIso(), id);
    return sendJson(res, 200, { ok: true });
  }

  if (method === "GET" && pathname === "/api/audit") {
    requireStaff(actor);
    const { page, limit, offset } = pageParams(url);
    const total = db.prepare("SELECT COUNT(*) AS n FROM audit_events").get().n;
    const items = db.prepare(`
      SELECT a.*, u.name AS actor_name
      FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.id DESC LIMIT ? OFFSET ?
    `).all(limit, offset).map((row) => ({
      id: row.id,
      actorName: row.actor_name || "System",
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      organizationId: row.organization_id,
      createdAt: row.created_at,
    }));
    return sendJson(res, 200, { items, page, pageSize: limit, total });
  }

  if (method === "POST" && pathname === "/api/admin/backup") {
    requireAdmin(actor);
    const directory = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"), "backups");
    const destination = backupDatabase(db, directory);
    audit(db, actor.id, "backup.create", "backup", path.basename(destination), null, null);
    return sendJson(res, 201, { file: path.basename(destination) });
  }

  throw new HttpError(404, "Not found.");
}

export function createApp(db) {
  return http.createServer((req, res) => {
    dispatch(db, req, res).catch((error) => {
      if (res.headersSent) return;
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      sendJson(res, status, { error: status === 500 ? "Something went wrong." : error.message });
    });
  });
}
