import fs from "node:fs";
import path from "node:path";

export function backupDatabase(db, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.resolve(directory, `osvia-${stamp}.sqlite`);
  const sqlPath = destination.replaceAll("\\", "/").replaceAll("'", "''");
  db.exec(`VACUUM INTO '${sqlPath}'`);
  return destination;
}
