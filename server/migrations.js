const V1 = `
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
  last_connection TEXT,
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

function seedPlansV1(db) {
  const insert = db.prepare(`
    INSERT INTO service_plans (name, price_ugx, device_limit, support_hours, response_target_hours, description, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  insert.run("Starter", 20000, 5, 2, 24, "Monthly support for a small shop or office.");
  insert.run("Business", 50000, 20, 8, 8, "Wider device coverage and a faster response target.");
  insert.run("Managed IT", 150000, 100, 40, 4, "Starting price for managed IT. The final scope is agreed with the organization.");
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function addColumn(db, table, definition) {
  const column = definition.split(/\s+/)[0];
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

const V3_TABLES = `
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'technician', 'customer_admin', 'customer_user')),
  active INTEGER NOT NULL DEFAULT 1,
  phone TEXT,
  mfa_secret TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  email_notifications INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  password_changed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((role IN ('admin', 'technician') AND organization_id IS NULL)
      OR (role IN ('customer_admin', 'customer_user') AND organization_id IS NOT NULL))
);
INSERT INTO users_new (id, organization_id, name, email, password_hash, role, active, created_at)
  SELECT id,
         CASE WHEN role IN ('admin', 'technician') THEN NULL ELSE organization_id END,
         name, email, password_hash,
         CASE role WHEN 'customer' THEN 'customer_admin' ELSE role END,
         active, created_at
  FROM users;
DROP TABLE sessions;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX idx_users_org ON users(organization_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  mfa_verified INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE mfa_challenges (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);

CREATE TABLE invitations (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id),
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('technician', 'customer_admin', 'customer_user')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invitations_org ON invitations(organization_id);

CREATE TABLE ticket_events (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  actor_id INTEGER REFERENCES users(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ticket_events_ticket ON ticket_events(ticket_id);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('customer', 'internal')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachments_ticket ON attachments(ticket_id);

CREATE TABLE sla_policies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  plan_id INTEGER REFERENCES service_plans(id),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  category TEXT,
  response_minutes INTEGER NOT NULL CHECK (response_minutes > 0),
  resolution_minutes INTEGER CHECK (resolution_minutes IS NULL OR resolution_minutes > 0),
  business_hours_only INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'Africa/Kampala',
  business_start TEXT NOT NULL DEFAULT '08:00',
  business_end TEXT NOT NULL DEFAULT '17:00',
  business_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
  exclude_holidays INTEGER NOT NULL DEFAULT 1,
  escalate_at_percent INTEGER NOT NULL DEFAULT 75 CHECK (escalate_at_percent BETWEEN 1 AND 100),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sla_plan ON sla_policies(plan_id, priority);

CREATE TABLE holidays (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE maintenance_windows (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id),
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_windows_time ON maintenance_windows(starts_at, ends_at);

CREATE TABLE email_outbox (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT,
  kind TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_outbox_due ON email_outbox(status, next_attempt_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE integration_health (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  detail TEXT,
  checked_at TEXT NOT NULL
);

CREATE TABLE remote_sessions (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  technician_id INTEGER NOT NULL REFERENCES users(id),
  ticket_id INTEGER REFERENCES tickets(id),
  mode TEXT NOT NULL,
  reason TEXT NOT NULL,
  launched_at TEXT NOT NULL
);
CREATE INDEX idx_remote_org ON remote_sessions(organization_id);

CREATE TABLE device_assignments (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  user_id INTEGER REFERENCES users(id),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_device_assignments ON device_assignments(device_id);

CREATE TABLE monitors (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('http', 'tcp', 'ping')),
  target TEXT NOT NULL,
  port INTEGER,
  interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (interval_seconds >= 60),
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  failure_threshold INTEGER NOT NULL DEFAULT 2 CHECK (failure_threshold >= 1),
  expected_status TEXT NOT NULL DEFAULT '200-399',
  ssl_warning_days INTEGER NOT NULL DEFAULT 14,
  customer_visible INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_response_ms INTEGER,
  last_error TEXT,
  ssl_expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_monitors_org ON monitors(organization_id);

CREATE TABLE monitor_checks (
  id INTEGER PRIMARY KEY,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id),
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  response_ms INTEGER,
  status_code INTEGER,
  error TEXT
);
CREATE INDEX idx_monitor_checks ON monitor_checks(monitor_id, checked_at);

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  monitor_id INTEGER REFERENCES monitors(id),
  device_id INTEGER REFERENCES devices(id),
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('minor', 'major', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  customer_visible INTEGER NOT NULL DEFAULT 1,
  summary TEXT,
  started_at TEXT NOT NULL,
  resolved_at TEXT,
  last_notified_at TEXT,
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_incidents_org ON incidents(organization_id, status);
CREATE UNIQUE INDEX idx_incident_open_monitor ON incidents(monitor_id) WHERE status = 'open' AND monitor_id IS NOT NULL;
CREATE UNIQUE INDEX idx_incident_open_device ON incidents(device_id) WHERE status = 'open' AND device_id IS NOT NULL;

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  plan_id INTEGER REFERENCES service_plans(id),
  description TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL CHECK (status IN ('issued', 'paid', 'void')),
  issued_at TEXT NOT NULL,
  due_date TEXT NOT NULL,
  paid_at TEXT,
  voided_at TEXT,
  void_reason TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX idx_invoices_org ON invoices(organization_id, status);

CREATE TABLE subscription_events (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  plan_id INTEGER REFERENCES service_plans(id),
  actor_id INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_subscription_events_org ON subscription_events(organization_id);
`;

function seedV3(db, now) {
  db.prepare("UPDATE service_plans SET monitor_limit = 2 WHERE name = 'Starter'").run();
  db.prepare("UPDATE service_plans SET monitor_limit = 10 WHERE name = 'Business'").run();
  db.prepare("UPDATE service_plans SET monitor_limit = 50, onsite_visits = 1 WHERE name = 'Managed IT'").run();

  const targets = {
    Starter: { urgent: [240, null], high: [480, null], normal: [1440, null], low: [2880, null] },
    Business: { urgent: [120, null], high: [240, null], normal: [480, null], low: [1440, null] },
    "Managed IT": { urgent: [60, 480], high: [120, 960], normal: [240, 2400], low: [480, 4800] },
  };
  const insert = db.prepare(`
    INSERT INTO sla_policies (name, plan_id, priority, response_minutes, resolution_minutes, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const plan of db.prepare("SELECT id, name FROM service_plans").all()) {
    const table = targets[plan.name];
    if (!table) continue;
    for (const [priority, [response, resolution]] of Object.entries(table)) {
      insert.run(`${plan.name} ${priority}`, plan.id, priority, response, resolution, now);
    }
  }
  for (const [priority, response] of Object.entries({ urgent: 240, high: 480, normal: 1440, low: 2880 })) {
    insert.run(`No plan ${priority}`, null, priority, response, null, now);
  }

  const holiday = db.prepare("INSERT OR IGNORE INTO holidays (date, name) VALUES (?, ?)");
  for (const year of [2026, 2027]) {
    for (const [md, name] of [
      ["01-01", "New Year's Day"],
      ["01-26", "Liberation Day"],
      ["02-16", "Archbishop Janani Luwum Day"],
      ["03-08", "International Women's Day"],
      ["05-01", "Labour Day"],
      ["06-03", "Martyrs' Day"],
      ["06-09", "National Heroes' Day"],
      ["10-09", "Independence Day"],
      ["12-25", "Christmas Day"],
      ["12-26", "Boxing Day"],
    ]) {
      holiday.run(`${year}-${md}`, name);
    }
  }

  const setting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  setting.run("support_email", "");
  setting.run("support_phone", "");
  setting.run("default_currency", "UGX");
  setting.run("default_timezone", "Africa/Kampala");
  setting.run("invoice_prefix", "INV");
  setting.run("invoice_due_days", "14");
  setting.run("reopen_days", "14");
  setting.run("auto_close_days", "7");
  setting.run("escalation_text", "Open an urgent ticket. If the organization cannot work, call OSVIA on the support line while the ticket is open. An administrator reviews urgent tickets before routine work.");
}

function migrateV3(db, now) {
  db.exec(V3_TABLES);

  addColumn(db, "organizations", "approved_at TEXT");
  addColumn(db, "organizations", "suspended_at TEXT");
  addColumn(db, "organizations", "suspension_reason TEXT");
  addColumn(db, "organizations", "timezone TEXT NOT NULL DEFAULT 'Africa/Kampala'");
  addColumn(db, "organizations", "currency TEXT NOT NULL DEFAULT 'UGX'");
  addColumn(db, "organizations", "mesh_group_id TEXT");
  addColumn(db, "organizations", "onboarding_completed_at TEXT");
  db.exec("UPDATE organizations SET approved_at = created_at WHERE status = 'active' AND approved_at IS NULL");

  addColumn(db, "service_plans", "billing_period_months INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "service_plans", "currency TEXT NOT NULL DEFAULT 'UGX'");
  addColumn(db, "service_plans", "monitor_limit INTEGER NOT NULL DEFAULT 2");
  addColumn(db, "service_plans", "onsite_visits INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "service_plans", "remote_support INTEGER NOT NULL DEFAULT 1");

  for (const definition of [
    "asset_type TEXT NOT NULL DEFAULT 'computer'",
    "serial_number TEXT",
    "asset_tag TEXT",
    "assigned_user_id INTEGER REFERENCES users(id)",
    "manufacturer TEXT",
    "model TEXT",
    "hardware_notes TEXT",
    "install_date TEXT",
    "warranty_expiry TEXT",
    "condition TEXT NOT NULL DEFAULT 'unknown'",
    "operational_status TEXT NOT NULL DEFAULT 'in_service'",
    "notes TEXT",
    "source TEXT NOT NULL DEFAULT 'manual'",
    "mesh_node_id TEXT",
    "mesh_conn INTEGER",
    "mesh_synced_at TEXT",
    "archived_at TEXT",
    "updated_at TEXT",
  ]) addColumn(db, "devices", definition);
  db.exec("CREATE UNIQUE INDEX idx_devices_mesh ON devices(mesh_node_id) WHERE mesh_node_id IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX idx_devices_tag ON devices(organization_id, asset_tag) WHERE asset_tag IS NOT NULL");

  for (const definition of [
    "number TEXT",
    "category TEXT NOT NULL DEFAULT 'other'",
    "impact TEXT NOT NULL DEFAULT 'single_user'",
    "device_id INTEGER REFERENCES devices(id)",
    "sla_policy_id INTEGER REFERENCES sla_policies(id)",
    "first_response_at TEXT",
    "response_due_at TEXT",
    "resolution_due_at TEXT",
    "response_breached INTEGER NOT NULL DEFAULT 0",
    "resolution_breached INTEGER NOT NULL DEFAULT 0",
    "sla_paused_at TEXT",
    "sla_remaining_minutes INTEGER",
    "escalated_at TEXT",
    "closed_at TEXT",
    "reopened_count INTEGER NOT NULL DEFAULT 0",
  ]) addColumn(db, "tickets", definition);
  db.exec("UPDATE tickets SET number = 'OBC-' || printf('%06d', id) WHERE number IS NULL");
  db.exec("UPDATE tickets SET status = CASE status WHEN 'open' THEN 'new' WHEN 'assigned' THEN 'open' ELSE status END");
  db.exec("UPDATE tickets SET closed_at = updated_at WHERE status = 'closed' AND closed_at IS NULL");
  db.exec("CREATE UNIQUE INDEX idx_tickets_number ON tickets(number)");
  db.exec("CREATE INDEX idx_tickets_assignee ON tickets(assigned_to, status)");
  db.exec("CREATE INDEX idx_tickets_status ON tickets(status, created_at)");

  addColumn(db, "ticket_notes", "minutes_spent INTEGER");
  db.exec("UPDATE ticket_notes SET kind = CASE WHEN kind = 'work_log' THEN 'work_log' WHEN visibility = 'customer' THEN 'reply' ELSE 'note' END");

  addColumn(db, "maintenance_schedules", "assigned_to INTEGER REFERENCES users(id)");
  addColumn(db, "maintenance_schedules", "device_id INTEGER REFERENCES devices(id)");
  addColumn(db, "maintenance_schedules", "last_completed_at TEXT");
  addColumn(db, "maintenance_schedules", "reminder_sent_for TEXT");
  addColumn(db, "maintenance_records", "schedule_id INTEGER REFERENCES maintenance_schedules(id)");
  addColumn(db, "maintenance_records", "minutes_spent INTEGER");

  addColumn(db, "payments", "invoice_id INTEGER REFERENCES invoices(id)");
  addColumn(db, "payments", "currency TEXT NOT NULL DEFAULT 'UGX'");
  addColumn(db, "payments", "reconciliation_note TEXT");
  addColumn(db, "payments", "rejected_reason TEXT");
  db.exec("UPDATE payments SET status = CASE status WHEN 'recorded' THEN 'pending' WHEN 'confirmed' THEN 'verified' ELSE status END");
  db.exec("CREATE INDEX idx_payments_org ON payments(organization_id, status)");

  addColumn(db, "notifications", "kind TEXT");
  addColumn(db, "notifications", "link TEXT");
  addColumn(db, "audit_events", "ip TEXT");
  db.exec("CREATE INDEX idx_audit_created ON audit_events(created_at)");
  db.exec("CREATE INDEX idx_audit_org ON audit_events(organization_id)");
  db.exec("CREATE INDEX idx_login_attempts ON login_attempts(bucket, attempted_at)");

  seedV3(db, now);
}

const V4_TABLES = `
CREATE TABLE device_status_events (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
  previous_status TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_device_status_events ON device_status_events(device_id, id);
CREATE TABLE kb_articles (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'customers' CHECK (audience IN ('customers', 'staff')),
  published INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  helpful_yes INTEGER NOT NULL DEFAULT 0,
  helpful_no INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE password_resets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
`;

function migrateV4(db) {
  db.exec(V4_TABLES);
  addColumn(db, "audit_events", "reason TEXT");
  db.exec("CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id, id)");
  addColumn(db, "tickets", "csat_rating INTEGER");
  addColumn(db, "tickets", "csat_comment TEXT");
  addColumn(db, "tickets", "csat_at TEXT");
  addColumn(db, "monitors", "created_by INTEGER REFERENCES users(id)");
}

export const MIGRATIONS = [
  {
    version: 1,
    up(db) {
      db.exec(V1);
      seedPlansV1(db);
    },
  },
  {
    version: 2,
    up(db) {
      addColumn(db, "devices", "address TEXT");
      addColumn(db, "devices", "check_port INTEGER");
      addColumn(db, "devices", "reachability TEXT NOT NULL DEFAULT 'unknown'");
      addColumn(db, "devices", "last_checked TEXT");
    },
  },
  {
    version: 3,
    foreignKeysOff: true,
    up(db, now) {
      migrateV3(db, now);
    },
  },
  {
    version: 4,
    up(db) {
      migrateV4(db);
    },
  },
  {
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE location_events (
          id INTEGER PRIMARY KEY,
          device_id INTEGER NOT NULL REFERENCES devices(id),
          lat REAL NOT NULL,
          lng REAL NOT NULL,
          accuracy_m INTEGER,
          source TEXT NOT NULL CHECK (source IN ('manual', 'gps', 'ip', 'meshcentral')),
          label TEXT,
          ip TEXT,
          created_by INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_location_events ON location_events(device_id, id);
      `);
      addColumn(db, "devices", "last_lat REAL");
      addColumn(db, "devices", "last_lng REAL");
      addColumn(db, "devices", "last_location_at TEXT");
      addColumn(db, "devices", "last_location_source TEXT");
      addColumn(db, "devices", "last_location_label TEXT");
      addColumn(db, "devices", "last_location_accuracy INTEGER");
    },
  },
  {
    version: 6,
    up(db) {
      addColumn(db, "devices", "last_seen_ip TEXT");
      addColumn(db, "devices", "last_location_ip TEXT");
    },
  },
  {
    version: 7,
    up(db) {
      db.exec(`
        CREATE TABLE device_findings (
          id INTEGER PRIMARY KEY,
          device_id INTEGER NOT NULL REFERENCES devices(id),
          organization_id INTEGER NOT NULL REFERENCES organizations(id),
          created_by INTEGER NOT NULL REFERENCES users(id),
          kind TEXT NOT NULL CHECK (kind IN ('finding', 'next_step', 'note')),
          body TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_device_findings ON device_findings(device_id, id);
      `);
    },
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
