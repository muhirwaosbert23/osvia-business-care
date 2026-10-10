import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "./validate.js";

const SCHEMA = `
CREATE TABLE service_plans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price_ugx INTEGER NOT NULL,
  device_limit INTEGER NOT NULL,
  support_hours INTEGER NOT NULL,
  response_target_hours INTEGER NOT NULL,
  description TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE organizations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  plan_id INTEGER,
  subscription_status TEXT NOT NULL DEFAULT 'unpaid',
  renewal_date TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES service_plans(id)
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'technician', 'customer')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  operating_system TEXT,
  address TEXT,
  check_port INTEGER,
  reachability TEXT NOT NULL DEFAULT 'unknown',
  last_connection TEXT,
  last_checked TEXT,
  management_status TEXT NOT NULL DEFAULT 'not_connected',
  consent_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  assigned_to INTEGER,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (assigned_to) REFERENCES users(id)
);
CREATE TABLE ticket_notes (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (author_id) REFERENCES users(id)
);
CREATE TABLE maintenance_records (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  device_id INTEGER,
  technician_id INTEGER NOT NULL,
  summary TEXT NOT NULL,
  performed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (device_id) REFERENCES devices(id),
  FOREIGN KEY (technician_id) REFERENCES users(id)
);
CREATE TABLE maintenance_schedules (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  next_due TEXT NOT NULL,
  interval_days INTEGER,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  amount_ugx INTEGER NOT NULL,
  method TEXT NOT NULL,
  reference TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'recorded',
  recorded_by INTEGER NOT NULL,
  confirmed_by INTEGER,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id)
);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  marker TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  organization_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY,
  bucket TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX idx_tickets_org ON tickets(organization_id);
CREATE INDEX idx_devices_org ON devices(organization_id);
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE UNIQUE INDEX idx_notifications_marker ON notifications(user_id, marker) WHERE marker IS NOT NULL;
`;

function seedPlans(db) {
  const insert = db.prepare(`
    INSERT INTO service_plans (name, price_ugx, device_limit, support_hours, response_target_hours, description, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  insert.run("Starter", 20000, 5, 2, 24, "Monthly support for a small shop or office.");
  insert.run("Business", 50000, 20, 8, 8, "Wider device coverage and a faster response target.");
  insert.run("Managed IT", 150000, 100, 40, 4, "Starting price for managed IT. The final scope is agreed with the organization.");
}

export function openDatabase(filename) {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
  if (filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  const current = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version || 0;
  if (current < 1) {
    db.exec("BEGIN");
    try {
      db.exec(SCHEMA);
      seedPlans(db);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (1)").run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (!hasColumn(db, "devices", "address")) {
    db.exec("ALTER TABLE devices ADD COLUMN address TEXT");
    db.exec("ALTER TABLE devices ADD COLUMN check_port INTEGER");
    db.exec("ALTER TABLE devices ADD COLUMN reachability TEXT NOT NULL DEFAULT 'unknown'");
    db.exec("ALTER TABLE devices ADD COLUMN last_checked TEXT");
  }
  const latest = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version || 0;
  if (latest < 2) db.prepare("INSERT INTO schema_migrations (version) VALUES (2)").run();
}

export function notify(db, userId, title, body, marker = null) {
  if (marker) {
    const existing = db.prepare("SELECT id FROM notifications WHERE user_id = ? AND marker = ?").get(userId, marker);
    if (existing) return;
  }
  db.prepare("INSERT INTO notifications (user_id, title, body, marker, created_at) VALUES (?, ?, ?, ?, ?)").run(
    userId,
    title,
    body,
    marker,
    nowIso(),
  );
}

export function notifyOrganization(db, organizationId, title, body, marker = null) {
  const users = db.prepare("SELECT id FROM users WHERE organization_id = ? AND role = 'customer' AND active = 1").all(organizationId);
  for (const user of users) notify(db, user.id, title, body, marker);
}

export function notifyStaff(db, title, body) {
  const users = db.prepare("SELECT id FROM users WHERE role IN ('admin', 'technician') AND active = 1").all();
  for (const user of users) notify(db, user.id, title, body);
}

export function audit(db, actorId, action, entityType, entityId, organizationId, detail) {
  db.prepare(`
    INSERT INTO audit_events (actor_id, action, entity_type, entity_id, organization_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    actorId ?? null,
    action,
    entityType,
    entityId == null ? null : String(entityId),
    organizationId ?? null,
    detail ? JSON.stringify(detail) : null,
    nowIso(),
  );
}
