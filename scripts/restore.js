import fs from "node:fs";
import path from "node:path";
import { restoreBackup } from "../server/backup.js";
import { loadEnv, projectRoot } from "../server/env.js";

loadEnv();
const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error("Usage: npm run restore -- <backup file>. Stop the portal first.");
  process.exit(1);
}
const dataDir = path.resolve(projectRoot, process.env.DATA_DIR || "data");
const summary = restoreBackup(path.resolve(source), path.join(dataDir, "osvia.sqlite"));
console.log(`Restored schema version ${summary.version}: ${JSON.stringify(summary.counts)}`);
console.log("The previous database was kept next to it with a .before-restore suffix.");
