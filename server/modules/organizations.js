import { assertOrgAccess, isStaff, publicUser, requireRole, scopeOrgId } from "../auth.js";
import { audit, changes, transaction } from "../db.js";
import { HttpError } from "../errors.js";
import { reply } from "../http.js";
import { customerAdminIds, notifyUsers } from "../notify.js";
import { isValidTimeZone } from "../sla.js";
import { assertEmail, assertEnum, assertText, likePattern, nowIso, nullableText, optionalText, pageParams } from "../validate.js";

const ORG_SELECT = `
  SELECT o.*, p.name AS plan_name, p.price_ugx, p.currency AS plan_currency, p.device_limit, p.support_hours,
         p.response_target_hours, p.monitor_limit, p.billing_period_months
  FROM organizations o LEFT JOIN service_plans p ON p.id = o.plan_id
`;

export function mapOrg(row, actor) {
  const base = {
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone || "",
    location: row.location || "",
    status: row.status,
    planId: row.plan_id,
    planName: row.plan_name || "",
    price: row.price_ugx ?? null,
    currency: row.plan_currency || row.currency || "UGX",
    deviceLimit: row.device_limit ?? null,
    supportHours: row.support_hours ?? null,
    monitorLimit: row.monitor_limit ?? null,
    billingPeriodMonths: row.billing_period_months ?? null,
    subscriptionStatus: row.subscription_status,
    renewalDate: row.renewal_date,
    timezone: row.timezone,
    approvedAt: row.approved_at,
    suspendedAt: row.suspended_at,
    suspensionReason: row.suspension_reason || "",
    onboardingCompletedAt: row.onboarding_completed_at,
    createdAt: row.created_at,
  };
  if (actor && isStaff(actor)) base.meshGroupId = row.mesh_group_id || "";
  return base;
}

export function mustOrg(db, id) {
  const row = db.prepare(`${ORG_SELECT} WHERE o.id = ?`).get(id);
  if (!row) throw new HttpError(404, "Organization not found.");
  return row;
}

function onboarding(db, orgId) {
  const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(orgId);
  const count = (sql) => db.prepare(sql).get(orgId).n;
  const steps = [
    { key: "approved", label: "OSVIA approved the organization", done: org.status === "active" || Boolean(org.approved_at) },
    { key: "account", label: "A customer administrator account exists", done: count("SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND role = 'customer_admin' AND active = 1") > 0 },
    { key: "users", label: "Authorized users are added", done: count("SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND active = 1") > 1 },
    { key: "plan", label: "A service plan is active", done: org.subscription_status === "active" },
    { key: "devices", label: "At least one device is registered", done: count("SELECT COUNT(*) AS n FROM devices WHERE organization_id = ? AND archived_at IS NULL") > 0 },
    { key: "consent", label: "Remote-support consent is recorded for a device", done: count("SELECT COUNT(*) AS n FROM devices WHERE organization_id = ? AND consent_at IS NOT NULL") > 0 },
  ];
  return { steps, complete: steps.every((step) => step.done) };
}

function list({ db, actor, url }) {
  const { page, limit, offset, q, orderBy } = pageParams(url, { name: "o.name", created: "o.created_at", status: "o.status", renewal: "o.renewal_date" }, "created");
  const where = [];
  const args = [];
  if (!isStaff(actor)) {
    where.push("o.id = ?");
    args.push(actor.organizationId);
  }
  if (q) {
    where.push("(o.name LIKE ? ESCAPE '\\' OR o.contact_email LIKE ? ESCAPE '\\' OR o.contact_name LIKE ? ESCAPE '\\')");
    args.push(likePattern(q), likePattern(q), likePattern(q));
  }
  const status = url.searchParams.get("status");
  if (status) {
    where.push("o.status = ?");
    args.push(assertEnum(status, ["pending", "active", "suspended"], "status"));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM organizations o ${clause}`).get(...args).n;
  const rows = db.prepare(`${ORG_SELECT} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { items: rows.map((row) => mapOrg(row, actor)), page, pageSize: limit, total };
}

function get({ db, actor, params }) {
  assertOrgAccess(actor, params.id);
  const org = mustOrg(db, params.id);
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM devices WHERE organization_id = ? AND archived_at IS NULL) AS devices,
      (SELECT COUNT(*) FROM tickets WHERE organization_id = ? AND status IN ('new','open','in_progress','pending_customer')) AS open_tickets,
      (SELECT COUNT(*) FROM users WHERE organization_id = ? AND active = 1) AS users,
      (SELECT COUNT(*) FROM monitors WHERE organization_id = ?) AS monitors
  `).get(org.id, org.id, org.id, org.id);
  return {
    organization: mapOrg(org, actor),
    counts: { devices: counts.devices, openTickets: counts.open_tickets, users: counts.users, monitors: counts.monitors },
    onboarding: onboarding(db, org.id),
  };
}

function create({ db, actor, body }) {
  requireRole(actor, "admin");
  const info = db.prepare(`
    INSERT INTO organizations (name, contact_name, contact_email, contact_phone, location, status, subscription_status, approved_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', 'unpaid', ?, ?)
  `).run(
    assertText(body.name, "Organization name", 160),
    assertText(body.contactName, "Contact name", 120),
    assertEmail(body.contactEmail),
    optionalText(body.contactPhone, 40, "Phone"),
    optionalText(body.location, 160, "Location"),
    nowIso(),
    nowIso(),
  );
  const id = Number(info.lastInsertRowid);
  audit(db, actor.id, "organization.create", "organization", id, id, null, actor.ip);
  return reply(201, { organization: mapOrg(mustOrg(db, id), actor) });
}

function update({ db, actor, params, body }) {
  if (actor.role !== "admin" && actor.role !== "customer_admin") throw new HttpError(403, "Your role does not allow this action.");
  assertOrgAccess(actor, params.id);
  const org = mustOrg(db, params.id);
  const timezone = body.timezone === undefined ? org.timezone : String(body.timezone);
  if (!isValidTimeZone(timezone)) throw new HttpError(400, "Choose a valid time zone such as Africa/Kampala.");
  db.prepare(`
    UPDATE organizations SET name = ?, contact_name = ?, contact_email = ?, contact_phone = ?, location = ?, timezone = ? WHERE id = ?
  `).run(
    body.name === undefined ? org.name : assertText(body.name, "Organization name", 160),
    body.contactName === undefined ? org.contact_name : assertText(body.contactName, "Contact name", 120),
    body.contactEmail === undefined ? org.contact_email : assertEmail(body.contactEmail),
    body.contactPhone === undefined ? org.contact_phone : optionalText(body.contactPhone, 40, "Phone"),
    body.location === undefined ? org.location : optionalText(body.location, 160, "Location"),
    timezone,
    org.id,
  );
  if (actor.role === "admin" && body.meshGroupId !== undefined) {
    const meshGroupId = nullableText(body.meshGroupId, 200, "MeshCentral group id");
    if (meshGroupId && !/^[A-Za-z0-9/@$_.-]+$/.test(meshGroupId)) throw new HttpError(400, "The MeshCentral group id has unexpected characters.");
    db.prepare("UPDATE organizations SET mesh_group_id = ? WHERE id = ?").run(meshGroupId, org.id);
  }
  audit(db, actor.id, "organization.update", "organization", org.id, org.id, {
    changes: changes(org, mustOrg(db, org.id), ["name", "contact_name", "contact_email", "contact_phone", "location", "timezone", "mesh_group_id"]),
  }, actor.ip);
  return { organization: mapOrg(mustOrg(db, org.id), actor) };
}

function setStatus(action) {
  return ({ db, actor, params, body }) => {
    requireRole(actor, "admin");
    const org = mustOrg(db, params.id);
    const now = nowIso();
    transaction(db, () => {
      if (action === "approve") {
        if (org.status !== "pending") throw new HttpError(400, "Only a pending organization can be approved.");
        db.prepare("UPDATE organizations SET status = 'active', approved_at = ? WHERE id = ?").run(now, org.id);
        notifyUsers(db, customerAdminIds(db, org.id), {
          title: "Your organization is approved",
          body: "OSVIA approved your organization. Next steps: add your users, choose a plan, and register your computers.",
          kind: "onboarding",
          link: "dashboard",
        });
      } else if (action === "suspend") {
        if (org.status === "suspended") throw new HttpError(400, "This organization is already suspended.");
        const reason = assertText(body.reason, "Reason", 300);
        db.prepare("UPDATE organizations SET status = 'suspended', suspended_at = ?, suspension_reason = ? WHERE id = ?").run(now, reason, org.id);
        db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE organization_id = ?)").run(org.id);
      } else {
        if (org.status !== "suspended") throw new HttpError(400, "Only a suspended organization can be reactivated.");
        db.prepare("UPDATE organizations SET status = 'active', suspended_at = NULL, suspension_reason = NULL, approved_at = COALESCE(approved_at, ?) WHERE id = ?").run(now, org.id);
        notifyUsers(db, customerAdminIds(db, org.id), { title: "Access restored", body: "Your organization's access to OSVIA Business Care is active again.", kind: "onboarding", link: "dashboard" });
      }
      const reason = action === "suspend" ? body.reason : nullableText(body?.reason, 300, "Reason");
      audit(db, actor.id, `organization.${action}`, "organization", org.id, org.id, { reason, changes: { status: [org.status, action === "suspend" ? "suspended" : "active"] } }, actor.ip);
    });
    return { organization: mapOrg(mustOrg(db, org.id), actor) };
  };
}

function listUsers({ db, actor, url }) {
  const { page, limit, offset, q, orderBy } = pageParams(url, { name: "name", created: "created_at", role: "role" }, "created");
  const where = [];
  const args = [];
  if (!isStaff(actor)) {
    requireRole(actor, "customer_admin");
    where.push("organization_id = ?");
    args.push(actor.organizationId);
  } else {
    const orgParam = url.searchParams.get("organizationId");
    if (orgParam) {
      where.push("organization_id = ?");
      args.push(scopeOrgId(actor, orgParam));
    }
    const role = url.searchParams.get("role");
    if (role === "staff") where.push("role IN ('admin', 'technician')");
    else if (role) {
      where.push("role = ?");
      args.push(assertEnum(role, ["admin", "technician", "customer_admin", "customer_user"], "role"));
    }
  }
  if (q) {
    where.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')");
    args.push(likePattern(q), likePattern(q));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users ${clause}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM users ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...args, limit, offset).map(publicUser);
  return { items, page, pageSize: limit, total };
}

function updateUser({ db, actor, params, body }) {
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(params.id);
  if (!target) throw new HttpError(404, "Not found.");
  if (actor.role === "customer_admin") {
    if (target.organization_id !== actor.organizationId) throw new HttpError(404, "Not found.");
  } else {
    requireRole(actor, "admin");
  }
  if (target.id === actor.id) throw new HttpError(400, "Change your own account under Account settings.");
  let role = target.role;
  if (body.role !== undefined) {
    const allowed = target.organization_id ? ["customer_admin", "customer_user"] : ["admin", "technician"];
    role = assertEnum(body.role, allowed, "role");
  }
  const active = body.active === undefined ? target.active : (body.active ? 1 : 0);
  const reason = role !== target.role || active !== target.active ? assertText(body.reason, "Reason for the change", 300) : null;
  transaction(db, () => {
    if (target.role === "admin" && (active === 0 || role !== "admin")) {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
      if (admins <= 1) throw new HttpError(400, "Keep at least one active super administrator.");
    }
    db.prepare("UPDATE users SET role = ?, active = ? WHERE id = ?").run(role, active, target.id);
    if (active === 0 || role !== target.role) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    audit(db, actor.id, "user.update", "user", target.id, target.organization_id, { changes: changes(target, { role, active }, ["role", "active"]), reason }, actor.ip);
  });
  return { user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(target.id)) };
}

function resetMfa({ db, actor, params, body }) {
  requireRole(actor, "admin");
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(params.id);
  if (!target) throw new HttpError(404, "Not found.");
  if (target.id === actor.id) throw new HttpError(400, "Another administrator must reset your two-factor authentication.");
  const reason = assertText(body?.reason, "Reason for the reset", 300);
  db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?").run(target.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
  audit(db, actor.id, "user.mfa_reset", "user", target.id, target.organization_id, { reason }, actor.ip);
  return { ok: true };
}

export const routes = [
  ["GET", "/api/organizations", list],
  ["POST", "/api/organizations", create],
  ["GET", "/api/organizations/:id", get],
  ["PATCH", "/api/organizations/:id", update],
  ["POST", "/api/organizations/:id/approve", setStatus("approve")],
  ["POST", "/api/organizations/:id/suspend", setStatus("suspend")],
  ["POST", "/api/organizations/:id/reactivate", setStatus("reactivate")],
  ["GET", "/api/users", listUsers],
  ["PATCH", "/api/users/:id", updateUser],
  ["POST", "/api/users/:id/reset-mfa", resetMfa],
];
