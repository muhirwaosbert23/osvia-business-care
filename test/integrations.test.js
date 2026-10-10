import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { backupDatabase, restoreBackup, verifyBackup } from "../server/backup.js";
import { openDatabase, schemaVersion } from "../server/db.js";
import { autoCloseResolved, billingJobs, evaluateSla } from "../server/jobs.js";
import { syncDevices } from "../server/meshcentral.js";
import { recordMonitorResult, runDueMonitors } from "../server/monitoring.js";
import { deliverOutbox, notifyUsers, queueEmail } from "../server/notify.js";
import { hashPassword } from "../server/security.js";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "osvia-int-"));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(db) {
  const now = new Date().toISOString();
  const org = Number(db.prepare("INSERT INTO organizations (name, contact_name, contact_email, status, created_at) VALUES ('Acme', 'A', 'a@acme.test', 'active', ?)").run(now).lastInsertRowid);
  const admin = Number(db.prepare("INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Admin', 'admin@osvia.test', ?, 'admin', ?)").run(hashPassword("Correct-Horse-42"), now).lastInsertRowid);
  const customer = Number(db.prepare("INSERT INTO users (organization_id, name, email, password_hash, role, created_at) VALUES (?, 'Cust', 'c@acme.test', ?, 'customer_admin', ?)").run(org, hashPassword("Correct-Horse-42"), now).lastInsertRowid);
  return { org, admin, customer };
}

describe("email outbox", () => {
  test("retries with backoff, then fails permanently and clears the body", async () => {
    process.env.SMTP_HOST = "smtp.test";
    process.env.SMTP_FROM = "OSVIA <support@osvia.test>";
    try {
      const db = openDatabase(":memory:");
      queueEmail(db, { to: "x@acme.test", subject: "Hello", text: "Body", kind: "test" });
      const failing = { sendMail: async () => { throw Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }); } };
      let now = new Date();
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const result = await deliverOutbox(db, { transport: failing, now });
        assert.equal(result.failed, 1);
        const row = db.prepare("SELECT * FROM email_outbox").get();
        assert.equal(row.status, "pending");
        assert.equal(row.attempts, attempt);
        assert.equal((await deliverOutbox(db, { transport: failing, now })).failed, 0, "not retried before the backoff");
        now = new Date(Date.parse(row.next_attempt_at) + 1000);
      }
      await deliverOutbox(db, { transport: failing, now });
      const row = db.prepare("SELECT * FROM email_outbox").get();
      assert.equal(row.status, "failed");
      assert.equal(row.body_text, null);
      assert.equal(row.last_error, "ECONNREFUSED");
      assert.equal(db.prepare("SELECT status FROM integration_health WHERE name = 'smtp'").get().status, "error");

      const sent = [];
      queueEmail(db, { to: "y@acme.test", subject: "Ok", text: "Body", kind: "test" });
      await deliverOutbox(db, { transport: { sendMail: async (m) => sent.push(m) }, now });
      assert.equal(sent.length, 1);
      assert.equal(db.prepare("SELECT status, body_text FROM email_outbox WHERE to_email = 'y@acme.test'").get().status, "sent");
      db.close();
    } finally {
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_FROM;
    }
  });

  test("notification markers deduplicate in-app and email copies", () => {
    process.env.SMTP_HOST = "smtp.test";
    process.env.SMTP_FROM = "support@osvia.test";
    try {
      const db = openDatabase(":memory:");
      const { customer } = seed(db);
      for (let i = 0; i < 3; i += 1) notifyUsers(db, [customer, customer], { title: "Down", body: "x", marker: "incident-open:1" });
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get().n, 1);
      db.prepare("UPDATE users SET email_notifications = 0 WHERE id = ?").run(customer);
      notifyUsers(db, [customer], { title: "Other", body: "y" });
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get().n, 1, "preference respected");
      db.close();
    } finally {
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_FROM;
    }
  });

  test("without SMTP, messages are recorded as skipped rather than sent", async () => {
    const db = openDatabase(":memory:");
    queueEmail(db, { to: "x@acme.test", subject: "Hello", text: "Body", kind: "test" });
    const row = db.prepare("SELECT * FROM email_outbox").get();
    assert.equal(row.status, "skipped");
    assert.equal(row.body_text, null);
    await deliverOutbox(db);
    assert.equal(db.prepare("SELECT status FROM integration_health WHERE name = 'smtp'").get().status, "not_configured");
    db.close();
  });
});

describe("MeshCentral integration (fake meshctrl)", () => {
  let fake;
  before(() => {
    fake = path.join(dir, "meshctrl.js");
    fs.writeFileSync(fake, `
      const args = process.argv.slice(2);
      if (process.env.FAKE_MESH_FAIL) { console.error("Unable to connect"); process.exit(3); }
      if (!args.includes("--loginkeyfile")) { console.error("no login key"); process.exit(4); }
      if (args[0] === "serverinfo") { console.log(JSON.stringify({ name: "fake" })); process.exit(0); }
      if (args[0] === "listdevices") {
        const id = args[args.indexOf("--id") + 1];
        if (id === "mesh//groupA") console.log(JSON.stringify([
          { _id: "node//one", name: "FRONT-DESK", osdesc: "Windows 11", conn: 1 },
          { _id: "node//two", name: "BACK-OFFICE", conn: 0 },
          { _id: "bogus", name: "ignored" }
        ]));
        else console.log("[]");
        process.exit(0);
      }
      process.exit(2);
    `);
    fs.writeFileSync(path.join(dir, "key.txt"), "test-key");
    Object.assign(process.env, { MESHCENTRAL_URL: "https://mesh.test", MESHCTRL_PATH: fake, MESHCENTRAL_USER: "svc", MESHCENTRAL_LOGINKEY_FILE: path.join(dir, "key.txt") });
  });
  after(() => {
    for (const key of ["MESHCENTRAL_URL", "MESHCTRL_PATH", "MESHCENTRAL_USER", "MESHCENTRAL_LOGINKEY_FILE", "FAKE_MESH_FAIL"]) delete process.env[key];
  });

  test("imports devices into the mapped organization and reports status from conn", async () => {
    const db = openDatabase(":memory:");
    const { org } = seed(db);
    db.prepare("UPDATE organizations SET mesh_group_id = 'mesh//groupA' WHERE id = ?").run(org);
    const result = await syncDevices(db);
    assert.equal(result.status, "ok");
    assert.equal(result.created, 2);
    const devices = db.prepare("SELECT name, reachability, source, operating_system FROM devices ORDER BY name").all();
    assert.deepEqual(devices.map((d) => [d.name, d.reachability, d.source]), [["BACK-OFFICE", "offline", "meshcentral"], ["FRONT-DESK", "online", "meshcentral"]]);
    const again = await syncDevices(db);
    assert.equal(again.updated, 2);
    assert.equal(again.created, 0);
    db.close();
  });

  test("never moves a device that belongs to another organization", async () => {
    const db = openDatabase(":memory:");
    const { org } = seed(db);
    const other = Number(db.prepare("INSERT INTO organizations (name, contact_name, contact_email, status, created_at) VALUES ('Other', 'O', 'o@o.test', 'active', ?)").run(new Date().toISOString()).lastInsertRowid);
    db.prepare("INSERT INTO devices (organization_id, name, mesh_node_id, source, created_at) VALUES (?, 'Theirs', 'node//one', 'meshcentral', ?)").run(other, new Date().toISOString());
    db.prepare("UPDATE organizations SET mesh_group_id = 'mesh//groupA' WHERE id = ?").run(org);
    const result = await syncDevices(db);
    assert.equal(result.status, "error");
    assert.equal(db.prepare("SELECT organization_id FROM devices WHERE mesh_node_id = 'node//one'").get().organization_id, other);
    db.close();
  });

  test("a failing MeshCentral is reported as an error, not as healthy", async () => {
    process.env.FAKE_MESH_FAIL = "1";
    const db = openDatabase(":memory:");
    const { org } = seed(db);
    db.prepare("UPDATE organizations SET mesh_group_id = 'mesh//groupA' WHERE id = ?").run(org);
    const result = await syncDevices(db);
    delete process.env.FAKE_MESH_FAIL;
    assert.equal(result.status, "error");
    const health = db.prepare("SELECT status, detail FROM integration_health WHERE name = 'meshcentral'").get();
    assert.equal(health.status, "error");
    assert.match(health.detail, /exit 3/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM devices").get().n, 0);
    db.close();
  });
});

describe("migration from schema v2", () => {
  test("keeps every record, maps old values and writes a premigration backup", () => {
    const file = path.join(dir, "v2.sqlite");
    const backups = path.join(dir, "v2-backups");
    const old = openDatabase(file, { targetVersion: 2 });
    const now = new Date().toISOString();
    old.prepare("INSERT INTO organizations (name, contact_name, contact_email, status, created_at) VALUES ('Old Co', 'O', 'o@old.test', 'active', ?)").run(now);
    old.prepare("INSERT INTO users (organization_id, name, email, password_hash, role, created_at) VALUES (1, 'Cust', 'c@old.test', 'x', 'customer', ?)").run(now);
    old.prepare("INSERT INTO users (organization_id, name, email, password_hash, role, created_at) VALUES (1, 'Tech', 't@old.test', 'x', 'technician', ?)").run(now);
    old.prepare("INSERT INTO tickets (organization_id, created_by, title, description, priority, status, created_at, updated_at) VALUES (1, 1, 'Old', 'x', 'normal', 'assigned', ?, ?)").run(now, now);
    old.prepare("INSERT INTO payments (organization_id, amount_ugx, method, reference, status, recorded_by, created_at) VALUES (1, 50000, 'cash', 'R1', 'confirmed', 2, ?)").run(now);
    old.prepare("INSERT INTO devices (organization_id, name, address, created_at) VALUES (1, 'PC', '10.0.0.2', ?)").run(now);
    old.close();

    const db = openDatabase(file, { backupDir: backups });
    assert.equal(schemaVersion(db), 3);
    assert.equal(db.prepare("SELECT role FROM users WHERE email = 'c@old.test'").get().role, "customer_admin");
    const tech = db.prepare("SELECT role, organization_id FROM users WHERE email = 't@old.test'").get();
    assert.deepEqual({ ...tech }, { role: "technician", organization_id: null });
    const ticket = db.prepare("SELECT status, number FROM tickets").get();
    assert.deepEqual({ ...ticket }, { status: "open", number: "OBC-000001" });
    assert.equal(db.prepare("SELECT status FROM payments").get().status, "verified");
    assert.equal(db.prepare("SELECT address FROM devices").get().address, "10.0.0.2");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.close();
    assert.ok(fs.readdirSync(backups).some((name) => name.startsWith("premigration-v2-")));
  });
});

describe("backup and restore", () => {
  test("encrypted backups restore and verify; a wrong key is rejected", () => {
    const live = path.join(dir, "live.sqlite");
    const db = openDatabase(live);
    seed(db);
    const file = backupDatabase(db, path.join(dir, "bk"), { key: "a-long-backup-passphrase" });
    db.close();
    assert.ok(file.endsWith(".enc"));
    assert.equal(fs.readFileSync(file).subarray(0, 8).toString(), "OSVIABK1");
    assert.ok(!fs.readFileSync(file).includes(Buffer.from("admin@osvia.test")), "backup content is not plaintext");

    const target = path.join(dir, "restored.sqlite");
    assert.throws(() => restoreBackup(file, target, { key: "wrong-key" }));
    assert.ok(!fs.existsSync(target));
    const summary = restoreBackup(file, target, { key: "a-long-backup-passphrase" });
    assert.equal(summary.version, 3);
    assert.equal(summary.counts.users, 2);
    assert.equal(verifyBackup(target).counts.organizations, 1);
  });
});

describe("monitoring", () => {
  let server;
  let port;
  let healthy = true;
  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(healthy ? 200 : 503);
      res.end("ok");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  test("real HTTP checks open one incident after the threshold and resolve it on recovery", async () => {
    const db = openDatabase(":memory:");
    const { org } = seed(db);
    db.prepare("INSERT INTO monitors (organization_id, name, type, target, interval_seconds, failure_threshold, created_at) VALUES (?, 'Site', 'http', ?, 60, 2, ?)").run(org, `http://127.0.0.1:${port}/`, new Date().toISOString());
    const monitor = () => db.prepare("SELECT * FROM monitors").get();

    assert.equal(await runDueMonitors(db), 1);
    assert.equal(monitor().status, "up");
    assert.ok(monitor().last_response_ms >= 0);

    healthy = false;
    recordMonitorResult(db, monitor(), { ok: false, responseMs: null, statusCode: 503, error: "HTTP 503" });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM incidents").get().n, 0, "below the threshold");
    for (let i = 0; i < 3; i += 1) recordMonitorResult(db, monitor(), { ok: false, responseMs: null, statusCode: 503, error: "HTTP 503" });
    assert.equal(monitor().status, "down");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE status = 'open'").get().n, 1, "deduplicated");

    healthy = true;
    db.prepare("UPDATE monitors SET last_checked_at = NULL").run();
    await runDueMonitors(db);
    assert.equal(monitor().status, "up");
    assert.equal(db.prepare("SELECT status FROM incidents").get().status, "resolved");
    db.close();
  });

  test("maintenance windows suppress new incidents", () => {
    const db = openDatabase(":memory:");
    const { org, admin } = seed(db);
    db.prepare("INSERT INTO monitors (organization_id, name, type, target, failure_threshold, created_at) VALUES (?, 'Site', 'tcp', '127.0.0.1', 1, ?)").run(org, new Date().toISOString());
    db.prepare("INSERT INTO maintenance_windows (organization_id, title, starts_at, ends_at, created_by, created_at) VALUES (?, 'Upgrade', ?, ?, ?, ?)").run(org, new Date(Date.now() - 60000).toISOString(), new Date(Date.now() + 3600000).toISOString(), admin, new Date().toISOString());
    recordMonitorResult(db, db.prepare("SELECT * FROM monitors").get(), { ok: false, responseMs: null, statusCode: null, error: "connection failed" });
    assert.equal(db.prepare("SELECT status FROM monitors").get().status, "down");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM incidents").get().n, 0);
    db.close();
  });
});

describe("scheduled jobs", () => {
  test("SLA breach and escalation are flagged once", () => {
    const db = openDatabase(":memory:");
    const { org, customer, admin } = seed(db);
    const policy = db.prepare("SELECT id FROM sla_policies WHERE plan_id IS NULL AND priority = 'urgent'").get().id;
    const created = "2026-10-12T05:00:00.000Z";
    db.prepare(`
      INSERT INTO tickets (organization_id, created_by, title, description, priority, status, sla_policy_id, response_due_at, created_at, updated_at, number)
      VALUES (?, ?, 'Server down', 'x', 'urgent', 'new', ?, '2026-10-12T09:00:00.000Z', ?, ?, 'OBC-000001')
    `).run(org, customer, policy, created, created);
    let result = evaluateSla(db, new Date("2026-10-12T08:30:00.000Z"));
    assert.equal(result.escalations, 1);
    assert.equal(result.breaches, 0);
    result = evaluateSla(db, new Date("2026-10-12T09:30:00.000Z"));
    assert.equal(result.breaches, 1);
    assert.equal(result.escalations, 0);
    assert.equal(evaluateSla(db, new Date("2026-10-12T10:00:00.000Z")).breaches, 0);
    assert.equal(db.prepare("SELECT response_breached FROM tickets").get().response_breached, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'sla'").get(admin).n, 2);
    db.close();
  });

  test("resolved tickets auto-close and lapsed subscriptions become past due", () => {
    const db = openDatabase(":memory:");
    const { org, customer } = seed(db);
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    db.prepare("INSERT INTO tickets (organization_id, created_by, title, description, priority, status, resolved_at, created_at, updated_at, number) VALUES (?, ?, 't', 'd', 'low', 'resolved', ?, ?, ?, 'OBC-000009')").run(org, customer, old, old, old);
    assert.equal(autoCloseResolved(db), 1);
    assert.equal(db.prepare("SELECT status FROM tickets").get().status, "closed");
    db.prepare("UPDATE organizations SET subscription_status = 'active', renewal_date = '2020-01-01' WHERE id = ?").run(org);
    assert.equal(billingJobs(db), 1);
    assert.equal(db.prepare("SELECT subscription_status FROM organizations").get().subscription_status, "past_due");
    db.close();
  });
});
