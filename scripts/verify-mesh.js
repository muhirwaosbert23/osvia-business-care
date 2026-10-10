import path from "node:path";
import { loadEnv, projectRoot } from "../server/env.js";
import { openDatabase } from "../server/db.js";
import { checkHealth, remoteLaunchUrl, syncDevices } from "../server/meshcentral.js";

loadEnv(path.join(projectRoot, ".env"));
const db = openDatabase(path.join(projectRoot, "data", "osvia.sqlite"));
const health = await checkHealth(db);
const sync = await syncDevices(db);
const device = db.prepare("SELECT * FROM devices WHERE id = 5").get();
const desk = db.prepare("SELECT status, detail, checked_at FROM integration_health WHERE name = 'meshcentral'").get();
const urls = {
  desktop: remoteLaunchUrl(device, "desktop"),
  terminal: remoteLaunchUrl(device, "terminal"),
  files: remoteLaunchUrl(device, "files"),
  general: remoteLaunchUrl(device, "general"),
};
console.log(JSON.stringify({
  env: {
    url: process.env.MESHCENTRAL_URL,
    control: process.env.MESHCENTRAL_CONTROL_URL,
    user: process.env.MESHCENTRAL_USER,
    tlsInsecure: process.env.MESHCTRL_TLS_INSECURE,
    meshctrlExists: Boolean(process.env.MESHCTRL_PATH),
  },
  health,
  sync,
  desk,
  device: {
    id: device.id,
    name: device.name,
    meshNodeId: device.mesh_node_id,
    reachability: device.reachability,
    consentAt: device.consent_at,
    meshConn: device.mesh_conn,
    os: device.operating_system,
    lastSeenIp: device.last_seen_ip,
  },
  urls,
}, null, 2));
db.close();
