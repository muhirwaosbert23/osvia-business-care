import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { loadEnv, projectRoot } from "./env.js";
import { startScheduler } from "./jobs.js";
import { initAppSecret } from "./security.js";

loadEnv(path.join(projectRoot, ".env"));

const dataDir = path.resolve(projectRoot, process.env.DATA_DIR || "data");
process.env.DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });
const backupDir = path.join(dataDir, "backups");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3080);

if (process.env.NODE_ENV === "production") {
  const problems = [];
  if (process.env.COOKIE_SECURE !== "true") problems.push("COOKIE_SECURE must be true behind HTTPS.");
  if (!process.env.APP_URL?.startsWith("https://")) problems.push("APP_URL must be the public https:// address.");
  if (process.env.REQUIRE_STAFF_MFA === "false") problems.push("REQUIRE_STAFF_MFA cannot be false in production.");
  if (problems.length) {
    console.error(`Refusing to start in production:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
}

initAppSecret(dataDir);
const db = openDatabase(path.join(dataDir, "osvia.sqlite"), { backupDir });
const server = createApp(db);
server.headersTimeout = 20000;
server.requestTimeout = 60000;

server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE" ? `Port ${port} is already in use.` : error);
  process.exit(1);
});

let scheduler = null;
server.listen(port, host, () => {
  console.log(`OSVIA Business Care is running at http://${host}:${port}`);
  if (process.env.DISABLE_JOBS !== "true") scheduler = startScheduler(db, { backupDir });
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down.`);
  scheduler?.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  }, 8000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
