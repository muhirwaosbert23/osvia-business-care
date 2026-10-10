import { strict as assert } from "node:assert";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.js";
import { backupDatabase } from "../server/backup.js";
import { openDatabase } from "../server/db.js";
import { runReminders } from "../server/jobs.js";

async function start() {
  const dir = mkdtempSync(path.join(tmpdir(), "osvia-"));
  const db = openDatabase(path.join(dir, "app.sqlite"));
  const server = createApp(db);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    const jar = new Map();
    return {
      jar,
      async call(method, pathname, body) {
        const headers = { Accept: "application/json" };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (jar.get("sid")) headers.Cookie = `osvia_session=${jar.get("sid")}`;
        if (jar.get("csrf") && method !== "GET") headers["X-CSRF-Token"] = jar.get("csrf");
        const response = await fetch(base + pathname, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        for (const cookie of response.headers.getSetCookie?.() || []) {
          const [pair] = cookie.split(";");
          const [key, value] = pair.split("=");
          if (key === "osvia_session") jar.set("sid", decodeURIComponent(value || ""));
        }
        const text = await response.text();
        let data = {};
        if (text && (response.headers.get("content-type") || "").includes("json")) data = JSON.parse(text);
        if (data.csrfToken) jar.set("csrf", data.csrfToken);
        return { status: response.status, data, text, type: response.headers.get("content-type") };
      },
    };
  }

  return {
    db,
    dir,
    client,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

test("administrator setup, login, and rejected second setup", async () => {
  const app = await start();
  const admin = app.client();
  const health = await admin.call("GET", "/api/health");
  assert.equal(health.data.needsSetup, true);
  assert.equal(health.data.remoteManagement, "not_connected");

  const created = await admin.call("POST", "/api/setup", {
    name: "Osbert Admin",
    email: "admin@osvia.test",
    password: "correct horse battery",
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.user.role, "admin");
  assert.equal(await (await admin.call("GET", "/api/me")).data.user.email, "admin@osvia.test");

  const again = await app.client().call("POST", "/api/setup", {
    name: "Other",
    email: "other@osvia.test",
    password: "correct horse battery",
  });
  assert.equal(again.status, 403);

  const bad = await app.client().call("POST", "/api/login", { email: "admin@osvia.test", password: "wrong-password" });
  assert.equal(bad.status, 401);
  const me = await app.client().call("GET", "/api/me");
  assert.equal(me.status, 401);
  await app.stop();
});

test("customers are isolated and tickets move from open to resolved", async () => {
  const app = await start();
  const admin = app.client();
  await admin.call("POST", "/api/setup", { name: "Admin", email: "admin@osvia.test", password: "correct horse battery" });
  const tech = await admin.call("POST", "/api/users", {
    name: "Tech A",
    email: "tech@osvia.test",
    password: "correct horse battery",
    role: "technician",
  });
  assert.equal(tech.status, 201);

  const first = await admin.call("POST", "/api/organizations", {
    name: "Kampala Books",
    contactName: "Amina",
    contactEmail: "amina@books.test",
    contactPhone: "0700000001",
    location: "Kampala",
  });
  const second = await admin.call("POST", "/api/organizations", {
    name: "Jinja School",
    contactName: "Peter",
    contactEmail: "peter@school.test",
    location: "Jinja",
  });
  await admin.call("POST", "/api/users", {
    name: "Amina",
    email: "amina@books.test",
    password: "customer-password",
    role: "customer",
    organizationId: first.data.organization.id,
  });
  await admin.call("POST", "/api/users", {
    name: "Peter",
    email: "peter@school.test",
    password: "customer-password",
    role: "customer",
    organizationId: second.data.organization.id,
  });

  const amina = app.client();
  const login = await amina.call("POST", "/api/login", { email: "amina@books.test", password: "customer-password" });
  assert.equal(login.status, 200);
  const orgs = await amina.call("GET", "/api/organizations");
  assert.equal(orgs.data.total, 1);
  assert.equal(orgs.data.items[0].name, "Kampala Books");

  const ticket = await amina.call("POST", "/api/tickets", {
    title: "Printer is jammed",
    description: "The front desk printer stopped feeding paper.",
    priority: "high",
    organizationId: second.data.organization.id,
  });
  assert.equal(ticket.status, 201);
  assert.equal(ticket.data.ticket.organizationId, first.data.organization.id);

  const peter = app.client();
  await peter.call("POST", "/api/login", { email: "peter@school.test", password: "customer-password" });
  const hidden = await peter.call("GET", `/api/tickets/${ticket.data.ticket.id}`);
  assert.equal(hidden.status, 404);
  const peterDevices = await peter.call("GET", "/api/devices");
  assert.equal(peterDevices.data.total, 0);

  const technician = app.client();
  await technician.call("POST", "/api/login", { email: "tech@osvia.test", password: "correct horse battery" });
  const internal = await technician.call("POST", `/api/tickets/${ticket.data.ticket.id}/notes`, {
    body: "Checked the roller. Ordering a spare.",
    visibility: "internal",
    kind: "work_log",
  });
  assert.equal(internal.status, 201);
  const resolved = await technician.call("PATCH", `/api/tickets/${ticket.data.ticket.id}`, {
    status: "resolved",
    assignedTo: tech.data.user.id,
    resolutionSummary: "Replaced the pickup roller and printed a test page.",
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.ticket.status, "resolved");

  const visible = await amina.call("GET", `/api/tickets/${ticket.data.ticket.id}`);
  assert.equal(visible.data.ticket.resolutionSummary, "Replaced the pickup roller and printed a test page.");
  assert.equal(visible.data.notes.length, 0);

  const plans = await amina.call("PATCH", "/api/plans/1", { priceUgx: 1 });
  assert.equal(plans.status, 403);
  const backup = await amina.call("POST", "/api/admin/backup", {});
  assert.equal(backup.status, 403);
  await app.stop();
});

test("subscription stays unpaid until an administrator confirms payment and activates it", async () => {
  const app = await start();
  const admin = app.client();
  await admin.call("POST", "/api/setup", { name: "Admin", email: "admin@osvia.test", password: "correct horse battery" });
  const org = await admin.call("POST", "/api/organizations", {
    name: "Market Stall",
    contactName: "Grace",
    contactEmail: "grace@market.test",
  });
  const early = await admin.call("POST", `/api/organizations/${org.data.organization.id}/subscription`, { planId: 1 });
  assert.equal(early.status, 400);

  const payment = await admin.call("POST", "/api/payments", {
    organizationId: org.data.organization.id,
    amountUgx: 20000,
    method: "cash",
    reference: "receipt-100",
  });
  assert.equal(payment.data.payment.status, "recorded");
  const stillBlocked = await admin.call("POST", `/api/organizations/${org.data.organization.id}/subscription`, { planId: 1 });
  assert.equal(stillBlocked.status, 400);

  const confirmed = await admin.call("POST", `/api/payments/${payment.data.payment.id}/confirm`, {});
  assert.equal(confirmed.data.payment.status, "confirmed");
  const orgAfterPay = await admin.call("GET", `/api/organizations/${org.data.organization.id}`);
  assert.equal(orgAfterPay.data.organization.subscriptionStatus, "unpaid");

  const active = await admin.call("POST", `/api/organizations/${org.data.organization.id}/subscription`, { planId: 1 });
  assert.equal(active.status, 200);
  assert.equal(active.data.organization.subscriptionStatus, "active");
  assert.equal(active.data.organization.planName, "Starter");
  assert.ok(active.data.organization.renewalDate);

  await admin.call("POST", "/api/users", {
    name: "Tech",
    email: "tech2@osvia.test",
    password: "correct horse battery",
    role: "technician",
  });
  const technician = app.client();
  await technician.call("POST", "/api/login", { email: "tech2@osvia.test", password: "correct horse battery" });
  const denied = await technician.call("POST", `/api/organizations/${org.data.organization.id}/subscription`, { planId: 1 });
  assert.equal(denied.status, 403);
  await app.stop();
});

test("device records do not claim an online state and reports use stored rows", async () => {
  const app = await start();
  const admin = app.client();
  await admin.call("POST", "/api/setup", { name: "Admin", email: "admin@osvia.test", password: "correct horse battery" });
  const org = await admin.call("POST", "/api/organizations", {
    name: "Clinic",
    contactName: "Nurse",
    contactEmail: "desk@clinic.test",
  });
  const device = await admin.call("POST", "/api/devices", {
    organizationId: org.data.organization.id,
    name: "Reception PC",
    operatingSystem: "Windows 11",
    lastConnection: new Date().toISOString(),
    managementStatus: "online",
  });
  assert.equal(device.status, 201);
  assert.equal(device.data.device.lastConnection, null);
  assert.equal(device.data.device.reachability, "unknown");
  assert.equal(device.data.device.managementStatus, "not_connected");

  const consent = await admin.call("POST", `/api/devices/${device.data.device.id}/consent`, {});
  assert.equal(consent.data.managementStatus, "consent_recorded");
  assert.equal(consent.data.lastConnection, null);

  const record = await admin.call("POST", "/api/maintenance", {
    organizationId: org.data.organization.id,
    deviceId: device.data.device.id,
    summary: "Cleaned dust and updated Windows.",
    performedAt: "2026-10-01",
  });
  assert.equal(record.status, 201);
  const report = await admin.call("GET", `/api/maintenance?organizationId=${org.data.organization.id}`);
  assert.equal(report.data.records.length, 1);
  assert.equal(report.data.records[0].summary, "Cleaned dust and updated Windows.");

  const pdf = await admin.call("GET", `/api/reports/maintenance.pdf?organizationId=${org.data.organization.id}`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.type, /application\/pdf/);
  assert.ok(pdf.text.startsWith("%PDF"));
  await app.stop();
});

test("a device address check reports online and offline from a real connection", async () => {
  const listener = net.createServer((socket) => socket.end());
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  const app = await start();
  try {
    const admin = app.client();
    await admin.call("POST", "/api/setup", { name: "Admin", email: "admin@osvia.test", password: "correct horse battery" });
    const org = await admin.call("POST", "/api/organizations", {
      name: "Shop",
      contactName: "Ada",
      contactEmail: "ada@shop.test",
    });
    const online = await admin.call("POST", "/api/devices", {
      organizationId: org.data.organization.id,
      name: "Counter PC",
      address: "127.0.0.1",
      checkPort: port,
      managementStatus: "online",
    });
    assert.equal(online.status, 201);
    assert.equal(online.data.device.reachability, "online");
    assert.ok(online.data.device.lastConnection);

    await new Promise((resolve) => listener.close(resolve));
    const offline = await admin.call("POST", `/api/devices/${online.data.device.id}/check`, {});
    assert.equal(offline.status, 200);
    assert.equal(offline.data.device.reachability, "offline");

    const dashboard = await admin.call("GET", "/api/dashboard");
    assert.equal(dashboard.data.onlineDevices, 0);
    assert.equal(dashboard.data.offlineDevices, 1);
  } finally {
    await app.stop();
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
  }
});

test("missing CSRF token is rejected and a backup can be opened", async () => {
  const app = await start();
  const admin = app.client();
  await admin.call("POST", "/api/setup", { name: "Admin", email: "admin@osvia.test", password: "correct horse battery" });
  const org = await admin.call("POST", "/api/organizations", {
    name: "Backup Co",
    contactName: "Rita",
    contactEmail: "rita@backup.test",
  });
  admin.jar.delete("csrf");
  const blocked = await admin.call("POST", "/api/organizations", {
    name: "Should fail",
    contactName: "Nope",
    contactEmail: "nope@backup.test",
  });
  assert.equal(blocked.status, 403);

  const file = backupDatabase(app.db, path.join(app.dir, "backups"));
  const copy = new DatabaseSync(file, { readOnly: true });
  const row = copy.prepare("SELECT name FROM organizations WHERE name = ?").get("Backup Co");
  assert.equal(row.name, "Backup Co");
  copy.close();
  assert.equal(org.status, 201);
  await app.stop();
});

test("data remains after the database connection is reopened", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "osvia-restart-"));
  const file = path.join(dir, "app.sqlite");
  const first = openDatabase(file);
  first.prepare("INSERT INTO users (name, email, password_hash, role, active, created_at) VALUES (?, ?, ?, 'admin', 1, ?)").run(
    "Admin",
    "admin@osvia.test",
    "stored-hash",
    new Date().toISOString(),
  );
  first.close();
  const second = openDatabase(file);
  const row = second.prepare("SELECT email FROM users WHERE email = ?").get("admin@osvia.test");
  assert.equal(row.email, "admin@osvia.test");
  second.close();
});

test("a passed renewal date becomes past due without marking a new payment", async () => {
  const app = await start();
  const admin = app.client();
  await admin.call("POST", "/api/setup", { name: "Admin", email: "admin@osvia.test", password: "correct horse battery" });
  const org = await admin.call("POST", "/api/organizations", {
    name: "Due Org",
    contactName: "Sam",
    contactEmail: "sam@due.test",
  });
  await admin.call("POST", "/api/users", {
    name: "Sam",
    email: "sam@due.test",
    password: "customer-password",
    role: "customer",
    organizationId: org.data.organization.id,
  });
  app.db.prepare("UPDATE organizations SET subscription_status = 'active', renewal_date = '2020-01-01' WHERE id = ?").run(org.data.organization.id);
  runReminders(app.db, new Date("2026-10-10T00:00:00.000Z"));
  const updated = app.db.prepare("SELECT subscription_status FROM organizations WHERE id = ?").get(org.data.organization.id);
  assert.equal(updated.subscription_status, "past_due");
  const note = app.db.prepare("SELECT title FROM notifications WHERE title LIKE 'Renewal date%' LIMIT 1").get();
  assert.ok(note);
  const payments = app.db.prepare("SELECT COUNT(*) AS n FROM payments").get();
  assert.equal(payments.n, 0);
  await app.stop();
});
