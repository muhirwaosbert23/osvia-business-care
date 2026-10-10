import { CUSTOMER_ROLES, ROLE_LABELS, STAFF_ROLES } from "./constants.js";
import { audit, transaction } from "./db.js";
import { HttpError } from "./errors.js";
import { clientIp, readCookie, reply, sessionCookie } from "./http.js";
import { appUrl, notifyUsers, queueEmail, staffIds } from "./notify.js";
import { hashPassword, hashToken, newTotpSecret, openSecret, passwordOk, randomId, sealSecret, tokensMatch, verifyTotp } from "./security.js";
import { assertEmail, assertEnum, assertPassword, assertText, nowIso, optionalText } from "./validate.js";

const SESSION_SECONDS = 12 * 60 * 60;
const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 120);
const INVITE_DAYS = 7;

export function staffMfaRequired() {
  return process.env.REQUIRE_STAFF_MFA !== "false";
}

export function isStaff(actor) {
  return STAFF_ROLES.includes(actor.role);
}

export function requireRole(actor, ...roles) {
  if (!roles.includes(actor.role)) throw new HttpError(403, "Your role does not allow this action.");
}

export function requireStaff(actor) {
  requireRole(actor, ...STAFF_ROLES);
}

export function requireMfa(actor) {
  if (!actor.mfaEnabled || !actor.mfaVerified) {
    throw new HttpError(403, "Turn on two-factor authentication under Account before doing this.");
  }
}

export function scopeOrgId(actor, requested) {
  if (!isStaff(actor)) return actor.organizationId;
  const id = Number(requested);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "Choose an organization.");
  return id;
}

export function optionalOrgScope(actor, requested) {
  if (!isStaff(actor)) return actor.organizationId;
  if (requested === null || requested === undefined || requested === "") return null;
  return scopeOrgId(actor, requested);
}

export function assertOrgAccess(actor, organizationId) {
  if (!isStaff(actor) && actor.organizationId !== organizationId) throw new HttpError(404, "Not found.");
}

export function requireOperationalOrg(db, actor) {
  if (isStaff(actor)) return;
  const org = db.prepare("SELECT status FROM organizations WHERE id = ?").get(actor.organizationId);
  if (!org || org.status !== "active") {
    throw new HttpError(403, org?.status === "pending" ? "OSVIA is still reviewing this organization. You can do this once it is approved." : "This organization is not active.");
  }
}

export function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role],
    organizationId: row.organization_id ?? null,
    phone: row.phone || "",
    mfaEnabled: row.mfa_enabled === 1,
    emailNotifications: row.email_notifications === 1,
    active: row.active === 1,
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at,
  };
}

export function loadSession(db, req) {
  const raw = readCookie(req, "osvia_session");
  if (!raw) return null;
  const id = hashToken(raw);
  const row = db.prepare(`
    SELECT s.id AS session_id, s.csrf_token, s.expires_at, s.last_seen_at, s.mfa_verified, u.*,
           o.status AS organization_status
    FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN organizations o ON o.id = u.organization_id
    WHERE s.id = ?
  `).get(id);
  const now = new Date();
  if (!row || row.active !== 1 || row.expires_at < now.toISOString()) return null;
  if (now.getTime() - Date.parse(row.last_seen_at) > IDLE_MINUTES * 60000) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  if (row.organization_status === "suspended") return null;
  if (now.getTime() - Date.parse(row.last_seen_at) > 60000) {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now.toISOString(), id);
  }
  return {
    ...publicUser(row),
    csrfToken: row.csrf_token,
    sessionId: row.session_id,
    mfaVerified: row.mfa_verified === 1,
    organizationStatus: row.organization_status || null,
    ip: clientIp(req),
  };
}

export function tokensMatchCsrf(req, actor) {
  return tokensMatch(req.headers["x-csrf-token"], actor.csrfToken);
}

export function mustEnrollMfa(actor) {
  return isStaff(actor) && staffMfaRequired() && !actor.mfaEnabled;
}

function tooMany(db, bucket, limit, minutes) {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  return db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE bucket = ? AND attempted_at >= ?").get(bucket, since).n >= limit;
}

function recordAttempt(db, bucket) {
  db.prepare("INSERT INTO login_attempts (bucket, attempted_at) VALUES (?, ?)").run(bucket, nowIso());
}

export function rateLimit(db, bucket, limit, minutes, message) {
  if (tooMany(db, bucket, limit, minutes)) throw new HttpError(429, message);
  recordAttempt(db, bucket);
}

function createSession(db, req, userId, mfaVerified) {
  const raw = randomId();
  const csrfToken = randomId(24);
  const now = nowIso();
  db.prepare(`
    INSERT INTO sessions (id, user_id, csrf_token, mfa_verified, ip, user_agent, expires_at, last_seen_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(hashToken(raw), userId, csrfToken, mfaVerified ? 1 : 0, clientIp(req), String(req.headers["user-agent"] || "").slice(0, 200),
    new Date(Date.now() + SESSION_SECONDS * 1000).toISOString(), now, now);
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, userId);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  return reply(200, { user: publicUser(user), csrfToken, mustEnrollMfa: mustEnrollMfa(publicUser(user)) }, { "Set-Cookie": sessionCookie(raw, SESSION_SECONDS) });
}

export function needsSetup(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0;
}

export function setup(ctx) {
  const { db, body, req } = ctx;
  if (process.env.SETUP_TOKEN && !tokensMatch(body.setupToken, process.env.SETUP_TOKEN)) {
    throw new HttpError(403, "The setup token is not correct.");
  }
  const userId = transaction(db, () => {
    if (!needsSetup(db)) throw new HttpError(403, "The administrator account already exists.");
    const info = db.prepare("INSERT INTO users (name, email, password_hash, role, active, password_changed_at, created_at) VALUES (?, ?, ?, 'admin', 1, ?, ?)").run(
      assertText(body.name, "Name", 120), assertEmail(body.email), hashPassword(assertPassword(body.password)), nowIso(), nowIso(),
    );
    audit(db, Number(info.lastInsertRowid), "admin.setup", "user", info.lastInsertRowid, null, null, clientIp(req));
    return Number(info.lastInsertRowid);
  });
  return createSession(db, req, userId, false);
}

export function login(ctx) {
  const { db, body, req } = ctx;
  const email = assertEmail(body.email);
  const ip = clientIp(req);
  const bucket = `login:${ip}|${email}`;
  if (tooMany(db, bucket, 8, 15) || tooMany(db, `ip:${ip}`, 40, 15)) {
    throw new HttpError(429, "Too many sign-in attempts. Wait 15 minutes and try again.");
  }
  const user = db.prepare(`
    SELECT u.*, o.status AS organization_status FROM users u LEFT JOIN organizations o ON o.id = u.organization_id WHERE u.email = ?
  `).get(email);
  const matches = passwordOk(String(body.password || ""), user?.password_hash);
  if (!user || user.active !== 1 || !matches) {
    recordAttempt(db, bucket);
    recordAttempt(db, `ip:${ip}`);
    audit(db, user?.id ?? null, "login.failed", "session", null, user?.organization_id ?? null, null, ip);
    throw new HttpError(401, "Email or password is incorrect.");
  }
  if (user.organization_status === "suspended") {
    audit(db, user.id, "login.blocked_suspended", "session", null, user.organization_id, null, ip);
    throw new HttpError(403, "This organization's access is suspended. Contact OSVIA TECHNOLOGIES.");
  }
  db.prepare("DELETE FROM login_attempts WHERE bucket = ?").run(bucket);
  if (user.mfa_enabled === 1) {
    const challenge = randomId();
    db.prepare("INSERT INTO mfa_challenges (id, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(challenge), user.id, new Date(Date.now() + 5 * 60000).toISOString());
    return { mfaRequired: true, challenge };
  }
  audit(db, user.id, "login.succeeded", "session", null, user.organization_id, null, ip);
  return createSession(db, req, user.id, false);
}

export function loginMfa(ctx) {
  const { db, body, req } = ctx;
  const id = hashToken(String(body.challenge || ""));
  const challenge = db.prepare("SELECT * FROM mfa_challenges WHERE id = ?").get(id);
  if (!challenge || challenge.expires_at < nowIso() || challenge.attempts >= 5) {
    if (challenge) db.prepare("DELETE FROM mfa_challenges WHERE id = ?").run(id);
    throw new HttpError(401, "The sign-in step expired. Sign in again.");
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND active = 1").get(challenge.user_id);
  if (!user || !verifyTotp(openSecret(user.mfa_secret), body.code)) {
    db.prepare("UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = ?").run(id);
    audit(db, challenge.user_id, "login.mfa_failed", "session", null, user?.organization_id ?? null, null, clientIp(req));
    throw new HttpError(401, "That code is not correct.");
  }
  db.prepare("DELETE FROM mfa_challenges WHERE id = ?").run(id);
  audit(db, user.id, "login.succeeded", "session", null, user.organization_id, { mfa: true }, clientIp(req));
  return createSession(db, req, user.id, true);
}

export function logout(ctx) {
  ctx.db.prepare("DELETE FROM sessions WHERE id = ?").run(ctx.actor.sessionId);
  audit(ctx.db, ctx.actor.id, "logout", "session", null, ctx.actor.organizationId, null, ctx.actor.ip);
  return reply(200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
}

export function me(ctx) {
  const { actor, db } = ctx;
  const org = actor.organizationId ? db.prepare("SELECT id, name, status FROM organizations WHERE id = ?").get(actor.organizationId) : null;
  return {
    user: { ...publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(actor.id)) },
    organization: org,
    csrfToken: actor.csrfToken,
    mustEnrollMfa: mustEnrollMfa(actor),
    mfaVerified: actor.mfaVerified,
  };
}

export function register(ctx) {
  const { db, body, req } = ctx;
  if (needsSetup(db)) throw new HttpError(400, "Create the administrator account first.");
  rateLimit(db, `register:${clientIp(req)}`, 10, 60, "Too many registration attempts. Wait and try again.");
  const organizationName = assertText(body.organizationName, "Organization name", 160);
  const contactName = assertText(body.contactName, "Contact name", 120);
  const email = assertEmail(body.email);
  const phone = optionalText(body.phone, 40, "Phone");
  const location = optionalText(body.location, 160, "Location");
  const password = assertPassword(body.password);
  try {
    transaction(db, () => {
      const org = db.prepare(`
        INSERT INTO organizations (name, contact_name, contact_email, contact_phone, location, status, subscription_status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 'unpaid', ?)
      `).run(organizationName, contactName, email, phone, location, nowIso());
      const orgId = Number(org.lastInsertRowid);
      const user = db.prepare(`
        INSERT INTO users (organization_id, name, email, password_hash, role, phone, password_changed_at, created_at)
        VALUES (?, ?, ?, ?, 'customer_admin', ?, ?, ?)
      `).run(orgId, contactName, email, hashPassword(password), phone, nowIso(), nowIso());
      audit(db, Number(user.lastInsertRowid), "organization.register", "organization", orgId, orgId, null, clientIp(req));
      notifyUsers(db, staffIds(db, ["admin"]), { title: "Organization waiting for approval", body: `${organizationName} registered and needs review.`, kind: "onboarding", link: `organizations/${orgId}` });
    });
  } catch (error) {
    if (/UNIQUE/i.test(error.message || "")) throw new HttpError(409, "An account with that email already exists.");
    throw error;
  }
  return reply(201, { ok: true });
}

export function createInvitation(ctx) {
  const { db, body, actor } = ctx;
  const role = assertEnum(body.role, ["technician", "customer_admin", "customer_user"], "role");
  let organizationId = null;
  if (role === "technician") requireRole(actor, "admin");
  else {
    requireRole(actor, "admin", "technician", "customer_admin");
    organizationId = scopeOrgId(actor, body.organizationId);
    if (actor.role === "technician") throw new HttpError(403, "Ask an administrator to invite customer users.");
    const org = db.prepare("SELECT id, name, status FROM organizations WHERE id = ?").get(organizationId);
    if (!org) throw new HttpError(404, "Organization not found.");
    if (org.status === "suspended") throw new HttpError(400, "Reactivate the organization before inviting users.");
  }
  const email = assertEmail(body.email);
  const name = optionalText(body.name, 120, "Name");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new HttpError(409, "An account with that email already exists.");
  const token = randomId(24);
  const expires = new Date(Date.now() + INVITE_DAYS * 86400000).toISOString();
  const info = transaction(db, () => {
    db.prepare("UPDATE invitations SET revoked_at = ? WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL").run(nowIso(), email);
    const result = db.prepare(`
      INSERT INTO invitations (organization_id, email, name, role, token_hash, invited_by, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(organizationId, email, name || null, role, hashToken(token), actor.id, expires, nowIso());
    audit(db, actor.id, "invitation.create", "invitation", result.lastInsertRowid, organizationId, { role }, actor.ip);
    return result;
  });
  const link = `${appUrl()}/#/invite/${token}`;
  const emailed = queueEmail(db, {
    to: email,
    subject: "Your OSVIA Business Care invitation",
    text: `You have been invited to OSVIA Business Care as ${ROLE_LABELS[role]}.\n\nSet your password here within ${INVITE_DAYS} days:\n${link}\n\nIf you did not expect this, ignore this email.`,
    kind: "invitation",
  });
  return reply(201, { id: Number(info.lastInsertRowid), expiresAt: expires, emailed, link: emailed ? null : link });
}

export function listInvitations(ctx) {
  const { db, actor, url } = ctx;
  requireRole(actor, "admin", "technician", "customer_admin");
  const orgId = isStaff(actor) ? (url.searchParams.get("organizationId") ? scopeOrgId(actor, url.searchParams.get("organizationId")) : null) : actor.organizationId;
  const rows = db.prepare(`
    SELECT i.id, i.email, i.name, i.role, i.organization_id, i.expires_at, i.accepted_at, i.revoked_at, i.created_at, u.name AS invited_by_name
    FROM invitations i JOIN users u ON u.id = i.invited_by
    WHERE (? IS NULL AND (? = 1 OR i.organization_id IS NULL)) OR i.organization_id = ?
    ORDER BY i.id DESC LIMIT 100
  `).all(orgId, actor.role === "admin" ? 1 : 0, orgId);
  return {
    items: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name || "",
      role: row.role,
      organizationId: row.organization_id,
      invitedBy: row.invited_by_name,
      state: row.accepted_at ? "accepted" : row.revoked_at ? "revoked" : row.expires_at < nowIso() ? "expired" : "pending",
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
  };
}

export function revokeInvitation(ctx) {
  const { db, actor, params } = ctx;
  requireRole(actor, "admin", "customer_admin");
  const invite = db.prepare("SELECT * FROM invitations WHERE id = ?").get(params.id);
  if (!invite) throw new HttpError(404, "Not found.");
  if (actor.role === "customer_admin" && invite.organization_id !== actor.organizationId) throw new HttpError(404, "Not found.");
  if (invite.accepted_at) throw new HttpError(400, "This invitation was already accepted.");
  db.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ?").run(nowIso(), invite.id);
  audit(db, actor.id, "invitation.revoke", "invitation", invite.id, invite.organization_id, null, actor.ip);
  return { ok: true };
}

function findInvite(db, token) {
  const invite = db.prepare(`
    SELECT i.*, o.name AS organization_name FROM invitations i LEFT JOIN organizations o ON o.id = i.organization_id WHERE i.token_hash = ?
  `).get(hashToken(String(token || "")));
  if (!invite || invite.accepted_at || invite.revoked_at || invite.expires_at < nowIso()) {
    throw new HttpError(404, "This invitation is not valid. Ask for a new one.");
  }
  return invite;
}

export function inspectInvitation(ctx) {
  rateLimit(ctx.db, `invite:${clientIp(ctx.req)}`, 30, 15, "Too many attempts. Wait and try again.");
  const invite = findInvite(ctx.db, ctx.body.token);
  return { email: invite.email, name: invite.name || "", role: invite.role, roleLabel: ROLE_LABELS[invite.role], organizationName: invite.organization_name || "OSVIA TECHNOLOGIES" };
}

export function acceptInvitation(ctx) {
  const { db, body, req } = ctx;
  rateLimit(db, `invite:${clientIp(req)}`, 30, 15, "Too many attempts. Wait and try again.");
  const invite = findInvite(db, body.token);
  const name = assertText(body.name, "Name", 120);
  const password = assertPassword(body.password);
  const userId = transaction(db, () => {
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(invite.email)) throw new HttpError(409, "An account with that email already exists.");
    const info = db.prepare(`
      INSERT INTO users (organization_id, name, email, password_hash, role, phone, password_changed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(CUSTOMER_ROLES.includes(invite.role) ? invite.organization_id : null, name, invite.email, hashPassword(password), invite.role, optionalText(body.phone, 40, "Phone") || null, nowIso(), nowIso());
    db.prepare("UPDATE invitations SET accepted_at = ? WHERE id = ?").run(nowIso(), invite.id);
    audit(db, Number(info.lastInsertRowid), "invitation.accept", "user", info.lastInsertRowid, invite.organization_id, { role: invite.role }, clientIp(req));
    return Number(info.lastInsertRowid);
  });
  return createSession(db, req, userId, false);
}

export function changePassword(ctx) {
  const { db, body, actor } = ctx;
  rateLimit(db, `password:${actor.id}`, 10, 15, "Too many attempts. Wait and try again.");
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(actor.id);
  if (!passwordOk(String(body.currentPassword || ""), user.password_hash)) throw new HttpError(400, "The current password is not correct.");
  const next = assertPassword(body.newPassword);
  transaction(db, () => {
    db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(hashPassword(next), nowIso(), actor.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(actor.id, actor.sessionId);
    audit(db, actor.id, "password.change", "user", actor.id, actor.organizationId, null, actor.ip);
  });
  return { ok: true };
}

export function startMfa(ctx) {
  const { db, actor } = ctx;
  if (actor.mfaEnabled) throw new HttpError(400, "Two-factor authentication is already on.");
  const secret = newTotpSecret();
  db.prepare("UPDATE users SET mfa_secret = ? WHERE id = ?").run(sealSecret(secret), actor.id);
  const label = encodeURIComponent(`OSVIA Business Care:${actor.email}`);
  return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("OSVIA Business Care")}&digits=6&period=30` };
}

export function confirmMfa(ctx) {
  const { db, actor, body } = ctx;
  const user = db.prepare("SELECT mfa_secret, mfa_enabled FROM users WHERE id = ?").get(actor.id);
  if (!user.mfa_secret || user.mfa_enabled) throw new HttpError(400, "Start two-factor setup first.");
  if (!verifyTotp(openSecret(user.mfa_secret), body.code)) throw new HttpError(400, "That code is not correct. Check the time on your phone.");
  transaction(db, () => {
    db.prepare("UPDATE users SET mfa_enabled = 1 WHERE id = ?").run(actor.id);
    db.prepare("UPDATE sessions SET mfa_verified = 1 WHERE id = ?").run(actor.sessionId);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(actor.id, actor.sessionId);
    audit(db, actor.id, "mfa.enable", "user", actor.id, actor.organizationId, null, actor.ip);
  });
  return { ok: true };
}

export function disableMfa(ctx) {
  const { db, actor, body } = ctx;
  if (isStaff(actor) && staffMfaRequired()) throw new HttpError(400, "Staff accounts must keep two-factor authentication on.");
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(actor.id);
  if (!user.mfa_enabled || !verifyTotp(openSecret(user.mfa_secret), body.code)) throw new HttpError(400, "That code is not correct.");
  db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?").run(actor.id);
  audit(db, actor.id, "mfa.disable", "user", actor.id, actor.organizationId, null, actor.ip);
  return { ok: true };
}

export function listSessions(ctx) {
  const rows = ctx.db.prepare("SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC").all(ctx.actor.id, nowIso());
  return {
    items: rows.map((row) => ({
      id: row.id.slice(0, 12),
      current: row.id === ctx.actor.sessionId,
      ip: row.ip || "",
      userAgent: row.user_agent || "",
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    })),
  };
}

export function revokeOtherSessions(ctx) {
  const result = ctx.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(ctx.actor.id, ctx.actor.sessionId);
  audit(ctx.db, ctx.actor.id, "sessions.revoke", "user", ctx.actor.id, ctx.actor.organizationId, { count: result.changes }, ctx.actor.ip);
  return { revoked: result.changes };
}

export function updatePreferences(ctx) {
  const { db, actor, body } = ctx;
  const name = body.name === undefined ? actor.name : assertText(body.name, "Name", 120);
  const phone = body.phone === undefined ? actor.phone : optionalText(body.phone, 40, "Phone");
  const emailNotifications = body.emailNotifications === undefined ? (actor.emailNotifications ? 1 : 0) : (body.emailNotifications ? 1 : 0);
  db.prepare("UPDATE users SET name = ?, phone = ?, email_notifications = ? WHERE id = ?").run(name, phone || null, emailNotifications, actor.id);
  return { user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(actor.id)) };
}
