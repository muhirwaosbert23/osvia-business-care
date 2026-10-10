import { spawn } from "node:child_process";
import fs from "node:fs";
import { recordDeviceStatus, setHealth, transaction } from "./db.js";
import { HttpError } from "./errors.js";
import { nodeCoordinates, nodePublicIp } from "./geo.js";
import { locateFromPublicIp, saveLocation, shouldApplyDetected } from "./location.js";
import { announceDeviceStatus } from "./monitoring.js";
import { nowIso } from "./validate.js";

export function meshConfig() {
  return {
    publicUrl: (process.env.MESHCENTRAL_URL || "").replace(/\/+$/, ""),
    controlUrl: process.env.MESHCENTRAL_CONTROL_URL || "",
    meshctrl: process.env.MESHCTRL_PATH || "",
    user: process.env.MESHCENTRAL_USER || "",
    keyFile: process.env.MESHCENTRAL_LOGINKEY_FILE || "",
    passwordFile: process.env.MESHCENTRAL_PASSWORD_FILE || "",
    domain: process.env.MESHCENTRAL_DOMAIN || "",
  };
}

export function meshConfigured(config = meshConfig()) {
  return Boolean(config.publicUrl && config.meshctrl && config.user && (config.keyFile || config.passwordFile));
}

function authArgs(config) {
  const args = [];
  if (config.controlUrl) args.push("--url", config.controlUrl);
  args.push("--loginuser", config.user);
  if (config.keyFile) args.push("--loginkeyfile", config.keyFile);
  else args.push("--loginpass", fs.readFileSync(config.passwordFile, "utf8").trim());
  if (config.domain) args.push("--logindomain", config.domain);
  return args;
}

export function runMeshCtrl(command, extra = [], { timeoutMs = 25000, config = meshConfig() } = {}) {
  return new Promise((resolve, reject) => {
    if (!meshConfigured(config)) {
      reject(new Error("MeshCentral is not configured."));
      return;
    }
    let args;
    try {
      args = [config.meshctrl, command, ...extra, ...authArgs(config)];
    } catch {
      reject(new Error("The MeshCentral credential file cannot be read."));
      return;
    }
    const child = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(process.env.MESHCTRL_TLS_INSECURE === "true" ? { NODE_TLS_REJECT_UNAUTHORIZED: "0" } : {}),
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MeshCtrl ${command} timed out.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 20_000_000) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("MeshCtrl could not be started."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`MeshCtrl ${command} failed (exit ${code}). ${String(stderr || stdout).split(/\r?\n/)[0].slice(0, 160)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export function parseJsonOutput(text) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error("MeshCtrl did not return JSON.");
  return JSON.parse(text.slice(start));
}

export function flattenDevices(parsed) {
  if (Array.isArray(parsed)) return parsed.flatMap((item) => (Array.isArray(item?.nodes) ? item.nodes : [item]));
  if (parsed && typeof parsed === "object") {
    return Object.values(parsed).flatMap((value) => (Array.isArray(value) ? value : []));
  }
  return [];
}

export function nodeUrlId(nodeId) {
  return String(nodeId).replace(/^node\/[^/]*\//, "");
}

export async function checkHealth(db) {
  if (!meshConfigured()) {
    setHealth(db, "meshcentral", "not_configured", "Set MESHCENTRAL_URL, MESHCTRL_PATH, MESHCENTRAL_USER and a login key file.");
    return { status: "not_configured" };
  }
  try {
    await runMeshCtrl("serverinfo", ["--json"]);
    setHealth(db, "meshcentral", "ok", "MeshCtrl serverinfo succeeded.");
    return { status: "ok" };
  } catch (error) {
    setHealth(db, "meshcentral", "error", error.message);
    return { status: "error", detail: error.message };
  }
}

export async function syncDevices(db, { lookupFetch = fetch } = {}) {
  if (!meshConfigured()) {
    setHealth(db, "meshcentral", "not_configured", "MeshCentral is not configured, so no devices were synchronized.");
    return { status: "not_configured", updated: 0, created: 0, located: 0 };
  }
  const orgs = db.prepare("SELECT id, mesh_group_id FROM organizations WHERE mesh_group_id IS NOT NULL AND trim(mesh_group_id) != '' AND status != 'suspended'").all();
  let updated = 0;
  let created = 0;
  let located = 0;
  const pendingIp = [];
  const errors = [];
  for (const org of orgs) {
    let nodes;
    try {
      nodes = flattenDevices(parseJsonOutput(await runMeshCtrl("listdevices", ["--id", org.mesh_group_id, "--json"])));
    } catch (error) {
      errors.push(`Organization ${org.id}: ${error.message}`);
      continue;
    }
    const now = nowIso();
    const changes = [];
    transaction(db, () => {
      for (const node of nodes) {
        if (!node || typeof node._id !== "string" || !node._id.startsWith("node/")) continue;
        const conn = Number.isInteger(node.conn) ? node.conn : 0;
        const name = String(node.name || node.rname || "Unnamed device").slice(0, 120);
        const os = node.osdesc ? String(node.osdesc).slice(0, 120) : null;
        const existing = db.prepare("SELECT * FROM devices WHERE mesh_node_id = ?").get(node._id);
        if (existing && existing.organization_id !== org.id) {
          errors.push(`Device ${name} is mapped to another organization and was not moved.`);
          continue;
        }
        const reachability = conn > 0 ? "online" : "offline";
        let deviceId;
        if (existing) {
          db.prepare(`
            UPDATE devices SET name = ?, operating_system = COALESCE(?, operating_system), mesh_conn = ?, reachability = ?,
              last_checked = ?, last_connection = CASE WHEN ? > 0 THEN ? ELSE last_connection END, mesh_synced_at = ?, source = 'meshcentral', management_status = 'agent_installed', updated_at = ?
            WHERE id = ?
          `).run(name, os, conn, reachability, now, conn, now, now, now, existing.id);
          recordDeviceStatus(db, existing.id, existing.reachability, reachability, "meshcentral", now);
          if (existing.reachability !== reachability) changes.push({ device: { ...existing, name }, previous: existing.reachability, status: reachability });
          updated += 1;
          deviceId = existing.id;
        } else {
          const info = db.prepare(`
            INSERT INTO devices (organization_id, name, operating_system, source, mesh_node_id, mesh_conn, reachability, last_checked,
              last_connection, mesh_synced_at, management_status, created_at, updated_at)
            VALUES (?, ?, ?, 'meshcentral', ?, ?, ?, ?, ?, ?, 'agent_installed', ?, ?)
          `).run(org.id, name, os, node._id, conn, reachability, now, conn > 0 ? now : null, now, now, now);
          const createdDevice = { id: Number(info.lastInsertRowid), organization_id: org.id, name, assigned_user_id: null, last_connection: conn > 0 ? now : null };
          recordDeviceStatus(db, createdDevice.id, null, reachability, "meshcentral", now);
          changes.push({ device: createdDevice, previous: null, status: reachability });
          created += 1;
          deviceId = createdDevice.id;
        }
        const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId);
        const ip = nodePublicIp(node);
        if (ip) {
          db.prepare("UPDATE devices SET last_seen_ip = ?, address = COALESCE(NULLIF(address, ''), ?) WHERE id = ?").run(ip, ip, deviceId);
          device.last_seen_ip = ip;
          device.address = device.address || ip;
        }
        const coords = nodeCoordinates(node);
        if (coords && shouldApplyDetected(device, coords)) {
          saveLocation(db, device, coords);
          located += 1;
        } else if (ip) {
          pendingIp.push({ deviceId, ip });
        }
      }
    });
    for (const change of changes) announceDeviceStatus(db, change.device, change.previous, change.status, now);
  }
  for (const item of pendingIp) {
    const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(item.deviceId);
    try {
      const saved = await locateFromPublicIp(db, device, item.ip, lookupFetch);
      if (saved) located += 1;
    } catch {
      /* public-IP lookup is best-effort during sync */
    }
  }
  const status = errors.length ? "error" : "ok";
  setHealth(db, "meshcentral", status, errors.length ? errors.slice(0, 3).join(" ") : `Synchronized ${orgs.length} organization group(s): ${created} new, ${updated} updated, ${located} placed on the map.`);
  return { status, updated, created, located, errors };
}

export function remoteLaunchUrl(device, mode) {
  const config = meshConfig();
  if (!config.publicUrl) throw new HttpError(503, "MeshCentral is not configured.");
  const viewmode = { desktop: 11, terminal: 12, files: 13, general: 10 }[mode];
  return `${config.publicUrl}/?gotonode=${encodeURIComponent(nodeUrlId(device.mesh_node_id))}&viewmode=${viewmode}`;
}
