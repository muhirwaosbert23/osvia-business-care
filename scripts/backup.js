import path from "node:path";
import { backupDatabase, verifyBackup } from "../server/backup.js";
import { openDatabase } from "../server/db.js";
import { loadEnv, projectRoot } from "../server/env.js";

loadEnv();
const dataDir = path.resolve(projectRoot, process.env.DATA_DIR || "data");
const db = openDatabase(path.join(dataDir, "osvia.sqlite"), { backupDir: path.join(dataDir, "backups") });
const label = process.argv[2] || "osvia";
const file = backupDatabase(db, path.join(dataDir, "backups"), { label });
db.close();
if (!file.endsWith(".enc")) console.log(JSON.stringify(verifyBackup(file)));
console.log(`Backup written: ${file}`);
