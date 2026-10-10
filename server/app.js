import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as auth from "./auth.js";
import { HttpError } from "./errors.js";
import { readJson, readRaw, Reply, sameOrigin, sendJson, serveStatic } from "./http.js";
import { routes as adminRoutes } from "./modules/admin.js";
import { routes as billingRoutes } from "./modules/billing.js";
import { routes as deviceRoutes } from "./modules/devices.js";
import { routes as historyRoutes } from "./modules/history.js";
import { routes as liveRoutes } from "./live.js";
import { routes as maintenanceRoutes } from "./modules/maintenance.js";
import { routes as monitoringRoutes } from "./modules/monitors.js";
import { routes as organizationRoutes } from "./modules/organizations.js";
import { routes as reportRoutes } from "./modules/reports.js";
import { routes as slaRoutes } from "./modules/sla-admin.js";
import { routes as ticketRoutes } from "./modules/tickets.js";
import { getSetting } from "./db.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const coreRoutes = [
  ["GET", "/api/health", ({ db }) => ({ ok: true, needsSetup: auth.needsSetup(db), setupTokenRequired: Boolean(process.env.SETUP_TOKEN) }), { public: true }],
  ["GET", "/api/public-config", ({ db }) => ({
    product: "OSVIA BUSINESS CARE",
    company: "OSVIA TECHNOLOGIES",
    location: "Kampala, Uganda",
    website: "https://osviatech.com",
    supportEmail: getSetting(db, "support_email") || process.env.CONTACT_EMAIL || "",
    supportPhone: getSetting(db, "support_phone") || process.env.CONTACT_PHONE || "",
    escalation: getSetting(db, "escalation_text"),
  }), { public: true }],
  ["POST", "/api/setup", auth.setup, { public: true }],
  ["POST", "/api/login", auth.login, { public: true }],
  ["POST", "/api/login/mfa", auth.loginMfa, { public: true }],
  ["POST", "/api/register", auth.register, { public: true }],
  ["POST", "/api/invitations/inspect", auth.inspectInvitation, { public: true }],
  ["POST", "/api/invitations/accept", auth.acceptInvitation, { public: true }],
  ["POST", "/api/logout", auth.logout, { mfaExempt: true }],
  ["GET", "/api/me", auth.me, { mfaExempt: true }],
  ["PATCH", "/api/me", auth.updatePreferences, { mfaExempt: true }],
  ["POST", "/api/me/password", auth.changePassword, { mfaExempt: true }],
  ["POST", "/api/me/mfa/start", auth.startMfa, { mfaExempt: true }],
  ["POST", "/api/me/mfa/confirm", auth.confirmMfa, { mfaExempt: true }],
  ["POST", "/api/me/mfa/disable", auth.disableMfa, { mfaExempt: true }],
  ["GET", "/api/me/sessions", auth.listSessions, { mfaExempt: true }],
  ["POST", "/api/me/sessions/revoke-others", auth.revokeOtherSessions, { mfaExempt: true }],
  ["GET", "/api/invitations", auth.listInvitations],
  ["POST", "/api/invitations", auth.createInvitation],
  ["POST", "/api/invitations/:id/revoke", auth.revokeInvitation],
];

function compile(list) {
  return list.map(([method, pattern, handler, options = {}]) => {
    const keys = [];
    const source = pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
      keys.push(key);
      return "(\\d+)";
    });
    return { method, regex: new RegExp(`^${source}$`), keys, handler, options };
  });
}

const ROUTES = compile([
  ...coreRoutes,
  ...organizationRoutes,
  ...ticketRoutes,
  ...deviceRoutes,
  ...maintenanceRoutes,
  ...monitoringRoutes,
  ...billingRoutes,
  ...reportRoutes,
  ...slaRoutes,
  ...adminRoutes,
  ...historyRoutes,
  ...liveRoutes,
]);

function match(method, pathname) {
  let allowed = false;
  for (const route of ROUTES) {
    const found = route.regex.exec(pathname);
    if (!found) continue;
    if (route.method !== method) {
      allowed = true;
      continue;
    }
    const params = {};
    route.keys.forEach((key, index) => {
      params[key] = Number(found[index + 1]);
    });
    return { route, params };
  }
  if (allowed) throw new HttpError(405, "Method not allowed.");
  return null;
}

async function dispatch(db, req, res, services) {
  const url = new URL(req.url || "/", "http://localhost");
  const method = req.method || "GET";
  if (!url.pathname.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    return serveStatic(res, PUBLIC_DIR, url.pathname);
  }
  const found = match(method, url.pathname);
  if (!found) throw new HttpError(404, "Not found.");
  const { route, params } = found;
  const unsafe = method !== "GET" && method !== "HEAD";
  if (unsafe && !sameOrigin(req)) throw new HttpError(403, "Cross-site requests are not allowed.");

  if (route.options.stream) {
    req.setTimeout(0);
    res.setTimeout(0);
  } else {
    req.setTimeout(30000);
  }
  const ctx = { db, req, res, url, params, services, body: null, raw: null, actor: null };
  if (!route.options.public) {
    ctx.actor = auth.loadSession(db, req);
    if (!ctx.actor) throw new HttpError(401, "Sign in required.");
    if (unsafe && !auth.tokensMatchCsrf(req, ctx.actor)) throw new HttpError(403, "Your session token is missing. Refresh the page and try again.");
    if (!route.options.mfaExempt && auth.mustEnrollMfa(ctx.actor)) {
      throw new HttpError(403, "Turn on two-factor authentication under Account before using staff tools.");
    }
  }
  if (unsafe) {
    if (route.options.raw) ctx.raw = await readRaw(req, route.options.raw);
    else ctx.body = await readJson(req);
  }
  const result = await route.handler(ctx);
  if (res.headersSent || res.writableEnded) return;
  if (result instanceof Reply) return sendJson(res, result.status, result.body, result.headers);
  return sendJson(res, 200, result ?? { ok: true });
}

export function createApp(db, services = {}) {
  return http.createServer((req, res) => {
    dispatch(db, req, res, services).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      let status = error instanceof HttpError ? error.status : 500;
      let message = error.message;
      if (/FOREIGN KEY|CHECK constraint/i.test(error.message || "")) {
        status = 400;
        message = "That change conflicts with related records.";
      } else if (/UNIQUE constraint/i.test(error.message || "")) {
        status = 409;
        message = "A record with those details already exists.";
      }
      if (status === 500) console.error(new Date().toISOString(), req.method, req.url?.split("?")[0], error);
      sendJson(res, status, { error: status === 500 ? "Something went wrong. The error was logged." : message });
    });
  });
}
