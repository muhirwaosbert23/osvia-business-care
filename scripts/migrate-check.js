import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, schemaVersion } from "../server/db.js";

const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error("Usage: npm run migrate:check -- <database file>");
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osvia-migrate-"));
const copy = path.join(dir, "copy.sqlite");
fs.copyFileSync(source, copy);

const tables = ["organizations", "users", "devices", "tickets", "ticket_notes", "payments", "maintenance_records", "maintenance_schedules", "notifications", "audit_events"];
const before = new DatabaseSync(copy, { readOnly: true });
const beforeVersion = before.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
const counts = Object.fromEntries(tables.map((t) => [t, before.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
before.close();

const db = openDatabase(copy, { backupDir: path.join(dir, "backups") });
const after = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
const integrity = Object.values(db.prepare("PRAGMA integrity_check").get())[0];
const fk = db.prepare("PRAGMA foreign_key_check").all().length;
const version = schemaVersion(db);
db.close();

let ok = integrity === "ok" && fk === 0;
console.log(`Schema version ${beforeVersion} -> ${version}`);
for (const t of tables) {
  const same = counts[t] === after[t];
  if (!same) ok = false;
  console.log(`${same ? "same" : "CHANGED"}  ${t}: ${counts[t]} -> ${after[t]}`);
}
console.log(`integrity_check: ${integrity}, foreign key problems: ${fk}`);
console.log(`Premigration backup created: ${fs.readdirSync(path.join(dir, "backups")).length > 0}`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
