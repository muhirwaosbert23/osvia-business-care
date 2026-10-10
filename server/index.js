import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { refreshDevices } from "./checks.js";
import { openDatabase } from "./db.js";
import { runReminders } from "./jobs.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(path.join(root, ".env"));

const dataDir = path.resolve(root, process.env.DATA_DIR || "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = openDatabase(path.join(dataDir, "osvia.sqlite"));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3080);
const server = createApp(db);

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`OSVIA Business Care is running at http://${host}:${port}`);
});

runReminders(db);
const timer = setInterval(() => runReminders(db), 60 * 60 * 1000);
timer.unref();

let checking = false;
async function checkDevices() {
  if (checking) return;
  checking = true;
  try {
    await refreshDevices(db);
  } catch (error) {
    console.error(error);
  } finally {
    checking = false;
  }
}
checkDevices();
const reachabilityTimer = setInterval(checkDevices, 60 * 1000);
reachabilityTimer.unref();

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
