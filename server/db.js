import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupDatabase } from "./backup.js";
import { LATEST_VERSION, MIGRATIONS } from "./migrations.js";
import { nowIso } from "./validate.js";

export function openDatabase(filename, { backupDir = null, targetVersion = LATEST_VERSION } = {}) {
  const memory = filename === ":memory:";
  if (!memory) fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
  if (!memory) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, { backupDir: memory ? null : backupDir, targetVersion });
  return db;
}

export function schemaVersion(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  return db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version || 0;
}

function migrate(db, { backupDir, targetVersion }) {
  const current = schemaVersion(db);
  const pending = MIGRATIONS.filter((item) => item.version > current && item.version <= targetVersion);
  if (!pending.length) return;
  if (current > 0 && backupDir) {
    backupDatabase(db, backupDir, { label: `premigration-v${current}` });
  }
  for (const migration of pending) {
    if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db, nowIso());
      if (migration.foreignKeysOff) {
        const problems = db.prepare("PRAGMA foreign_key_check").all();
        if (problems.length) throw new Error(`Migration ${migration.version} left ${problems.length} broken references.`);
      }
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

export function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function audit(db, actorId, action, entityType, entityId, organizationId, detail, ip = null) {
  const { reason = null, ...rest } = detail || {};
  const cleaned = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  db.prepare(`
    INSERT INTO audit_events (actor_id, action, entity_type, entity_id, organization_id, detail, reason, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actorId ?? null,
    action,
    entityType,
    entityId == null ? null : String(entityId),
    organizationId ?? null,
    Object.keys(cleaned).length ? JSON.stringify(cleaned) : null,
    reason ? String(reason).slice(0, 500) : null,
    ip,
    nowIso(),
  );
}

// Returns { column: [before, after] } for the listed columns that changed, or undefined when nothing changed.
export function changes(before, after, columns) {
  const out = {};
  for (const column of columns) {
    const from = before?.[column] ?? null;
    const to = after?.[column] ?? null;
    if (String(from) === String(to)) continue;
    const short = (value) => (typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}…` : value);
    out[column] = [short(from), short(to)];
  }
  return Object.keys(out).length ? out : undefined;
}

// Stores a reachability change measured by a real check or agent report. Unchanged results are not stored.
export function recordDeviceStatus(db, deviceId, previous, status, source, at = nowIso()) {
  if (!["online", "offline"].includes(status) || previous === status) return false;
  db.prepare("INSERT INTO device_status_events (device_id, status, previous_status, source, created_at) VALUES (?, ?, ?, ?, ?)").run(deviceId, status, previous ?? null, source, at);
  return true;
}

export function getSetting(db, key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setHealth(db, name, status, detail) {
  db.prepare(`
    INSERT INTO integration_health (name, status, detail, checked_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at
  `).run(name, status, detail ? String(detail).slice(0, 500) : null, nowIso());
}
