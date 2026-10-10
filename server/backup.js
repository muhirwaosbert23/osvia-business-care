import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAGIC = Buffer.from("OSVIABK1");

function keyFrom(secret, salt) {
  return scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function sqlPath(file) {
  return path.resolve(file).replaceAll("\\", "/").replaceAll("'", "''");
}

export function backupDatabase(db, directory, { key = process.env.BACKUP_KEY, label = "osvia" } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const plain = path.resolve(directory, `${label}-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${sqlPath(plain)}'`);
  if (!key) return plain;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(key, salt), iv);
  const body = Buffer.concat([cipher.update(fs.readFileSync(plain)), cipher.final()]);
  const encrypted = `${plain}.enc`;
  fs.writeFileSync(encrypted, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]), { mode: 0o600 });
  fs.rmSync(plain);
  return encrypted;
}

export function decryptBackup(file, key, destination) {
  const data = fs.readFileSync(file);
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("This file is not an OSVIA encrypted backup.");
  if (!key) throw new Error("Set BACKUP_KEY to restore an encrypted backup.");
  let offset = MAGIC.length;
  const salt = data.subarray(offset, (offset += 16));
  const iv = data.subarray(offset, (offset += 12));
  const tag = data.subarray(offset, (offset += 16));
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(key, salt), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data.subarray(offset)), decipher.final()]);
  fs.writeFileSync(destination, plain, { mode: 0o600 });
  return destination;
}

export function verifyBackup(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    const result = Object.values(integrity)[0];
    if (result !== "ok") throw new Error(`Integrity check failed: ${result}`);
    const version = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version;
    const counts = {};
    for (const table of ["organizations", "users", "tickets", "devices", "payments"]) {
      counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    return { version, counts };
  } finally {
    db.close();
  }
}

export function restoreBackup(source, target, { key = process.env.BACKUP_KEY } = {}) {
  const staging = `${target}.restore-${Date.now()}`;
  if (source.endsWith(".enc")) decryptBackup(source, key, staging);
  else fs.copyFileSync(source, staging);
  const summary = verifyBackup(staging);
  if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.before-restore-${Date.now()}`);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(target + suffix)) fs.rmSync(target + suffix);
  }
  fs.renameSync(staging, target);
  return summary;
}

export function pruneBackups(directory, keep) {
  if (!fs.existsSync(directory)) return 0;
  const files = fs.readdirSync(directory)
    .filter((name) => /^osvia-.*\.sqlite(\.enc)?$/.test(name))
    .map((name) => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  let removed = 0;
  for (const file of files.slice(keep)) {
    fs.rmSync(path.join(directory, file.name));
    removed += 1;
  }
  return removed;
}
