import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { recordDeviceStatus, setHealth, transaction } from "./db.js";
import { publish } from "./live.js";
import { HttpError } from "./errors.js";
import { customerAdminIds, notifyUsers, orgWatchers, staffIds } from "./notify.js";
import { assertHost, pingHost, probe, tcpOpen } from "./probe.js";
import { nowIso } from "./validate.js";

export const PUBLIC_ONLY_SQL = "COALESCE((SELECT role IN ('customer_admin', 'customer_user') FROM users WHERE id = m.created_by), 0)";

export function assertMonitorTarget(type, target) {
  if (type === "http") {
    let url;
    try {
      url = new URL(String(target || "").trim());
    } catch {
      throw new HttpError(400, "Enter a full URL such as https://example.co.ug.");
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new HttpError(400, "Only http and https URLs can be monitored.");
    if (url.username || url.password) throw new HttpError(400, "Do not put credentials in a monitored URL.");
    assertHost(url.hostname.replace(/^\[|\]$/g, ""));
    return url.toString();
  }
  return assertHost(target);
}

const PRIVATE_RANGES = new net.BlockList();
for (const [prefix, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]) {
  PRIVATE_RANGES.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) PRIVATE_RANGES.addSubnet(prefix, bits, "ipv6");

export function isPrivateAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return PRIVATE_RANGES.check(mapped[1], "ipv4");
  return PRIVATE_RANGES.check(address, net.isIPv6(address) ? "ipv6" : "ipv4");
}

// Customer-added websites must resolve only to public addresses, so they cannot be used to probe OSVIA's own network.
export async function assertPublicUrl(target) {
  const url = new URL(target);
  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) throw new HttpError(400, "Use a standard web port (80, 443, 8080 or 8443).");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new HttpError(400, "That website address could not be found. Check the spelling.");
    }
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new HttpError(400, "Only public website addresses can be added here. Ask OSVIA to monitor internal systems for you.");
  }
  return url.toString();
}

export function statusMatches(expected, code) {
  return String(expected || "200-399").split(",").some((part) => {
    const [low, high] = part.trim().split("-").map(Number);
    return Number.isInteger(low) && code >= low && code <= (Number.isInteger(high) ? high : low);
  });
}

function certificateExpiry(hostname, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert?.valid_to ? new Date(cert.valid_to).toISOString() : null);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(null);
    });
    socket.once("error", () => resolve(null));
  });
}

export async function checkMonitor(monitor) {
  const started = Date.now();
  if (monitor.type === "http") {
    if (monitor.public_only) {
      try {
        await assertPublicUrl(monitor.target);
      } catch (error) {
        return { ok: false, responseMs: null, statusCode: null, error: error.message.slice(0, 120), sslExpiresAt: null };
      }
    }
    try {
      const response = await fetch(monitor.target, {
        method: "GET",
        redirect: monitor.public_only ? "manual" : "follow",
        signal: AbortSignal.timeout(monitor.timeout_ms),
        headers: { "User-Agent": "OSVIA-Business-Care-Monitor/1.0" },
      });
      await response.body?.cancel();
      const ok = statusMatches(monitor.expected_status, response.status);
      let sslExpiresAt = null;
      const url = new URL(monitor.target);
      if (url.protocol === "https:") sslExpiresAt = await certificateExpiry(url.hostname, Number(url.port || 443), 8000);
      return { ok, responseMs: Date.now() - started, statusCode: response.status, error: ok ? null : `HTTP ${response.status}`, sslExpiresAt };
    } catch (error) {
      return { ok: false, responseMs: null, statusCode: null, error: String(error?.cause?.code || error?.name || "request failed").slice(0, 120), sslExpiresAt: null };
    }
  }
  if (monitor.type === "tcp") {
    const ok = await tcpOpen(monitor.target, monitor.port, monitor.timeout_ms);
    return { ok, responseMs: ok ? Date.now() - started : null, statusCode: null, error: ok ? null : "connection failed", sslExpiresAt: null };
  }
  const ok = await pingHost(monitor.target);
  return { ok, responseMs: ok ? Date.now() - started : null, statusCode: null, error: ok ? null : "no ping reply", sslExpiresAt: null };
}

export function inMaintenance(db, organizationId, at = nowIso()) {
  return Boolean(db.prepare(`
    SELECT 1 FROM maintenance_windows WHERE starts_at <= ? AND ends_at > ? AND (organization_id IS NULL OR organization_id = ?) LIMIT 1
  `).get(at, at, organizationId));
}

function openIncident(db, { organizationId, monitorId = null, deviceId = null, title, severity, customerVisible }) {
  const now = nowIso();
  const result = db.prepare(`
    INSERT OR IGNORE INTO incidents (organization_id, monitor_id, device_id, title, severity, status, customer_visible, started_at, last_notified_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(organizationId, monitorId, deviceId, title, severity, customerVisible ? 1 : 0, now, now);
  if (!result.changes) return null;
  const id = Number(result.lastInsertRowid);
  const recipients = staffIds(db);
  if (customerVisible) recipients.push(...customerAdminIds(db, organizationId));
  notifyUsers(db, recipients, { title: `Incident: ${title}`, body: `Started ${now}.`, kind: "incident", link: `incidents/${id}`, marker: `incident-open:${id}` });
  return id;
}

function resolveIncident(db, where, value, summary) {
  const incident = db.prepare(`SELECT * FROM incidents WHERE ${where} = ? AND status = 'open'`).get(value);
  if (!incident) return;
  const now = nowIso();
  db.prepare("UPDATE incidents SET status = 'resolved', resolved_at = ?, summary = COALESCE(summary, ?) WHERE id = ?").run(now, summary, incident.id);
  const recipients = staffIds(db);
  if (incident.customer_visible) recipients.push(...customerAdminIds(db, incident.organization_id));
  notifyUsers(db, recipients, { title: `Recovered: ${incident.title}`, body: `Resolved ${now}.`, kind: "incident", link: `incidents/${incident.id}`, marker: `incident-resolved:${incident.id}` });
}

export function recordMonitorResult(db, monitor, result) {
  const now = nowIso();
  transaction(db, () => {
    db.prepare("INSERT INTO monitor_checks (monitor_id, checked_at, ok, response_ms, status_code, error) VALUES (?, ?, ?, ?, ?, ?)").run(
      monitor.id, now, result.ok ? 1 : 0, result.responseMs ?? null, result.statusCode ?? null, result.error ?? null,
    );
    const failures = result.ok ? 0 : monitor.consecutive_failures + 1;
    const maintenance = inMaintenance(db, monitor.organization_id, now);
    const status = result.ok ? "up" : failures >= monitor.failure_threshold ? "down" : monitor.status === "unknown" ? "unknown" : monitor.status;
    db.prepare(`
      UPDATE monitors SET status = ?, consecutive_failures = ?, last_checked_at = ?, last_response_ms = ?, last_error = ?, ssl_expires_at = COALESCE(?, ssl_expires_at)
      WHERE id = ?
    `).run(status, failures, now, result.responseMs ?? null, result.error ?? null, result.sslExpiresAt ?? null, monitor.id);
    if (status === "down" && !maintenance) {
      openIncident(db, { organizationId: monitor.organization_id, monitorId: monitor.id, title: `${monitor.name} is not responding`, severity: "major", customerVisible: monitor.customer_visible === 1 });
    }
    if (result.ok) resolveIncident(db, "monitor_id", monitor.id, "The monitor check succeeded again.");
    if (result.sslExpiresAt) {
      const days = Math.floor((Date.parse(result.sslExpiresAt) - Date.now()) / 86400000);
      if (days <= monitor.ssl_warning_days) {
        notifyUsers(db, staffIds(db), {
          title: `Certificate for ${monitor.name} expires in ${days} day(s)`,
          body: `The TLS certificate expires on ${result.sslExpiresAt.slice(0, 10)}.`,
          kind: "ssl",
          link: "monitoring",
          marker: `ssl:${monitor.id}:${result.sslExpiresAt.slice(0, 10)}`,
        });
      }
    }
  });
}

export async function runDueMonitors(db, now = new Date()) {
  const due = db.prepare(`
    SELECT *, ${PUBLIC_ONLY_SQL} AS public_only FROM monitors m WHERE active = 1
      AND (last_checked_at IS NULL OR datetime(last_checked_at, '+' || interval_seconds || ' seconds') <= datetime(?))
    ORDER BY last_checked_at LIMIT 25
  `).all(now.toISOString());
  for (const monitor of due) {
    recordMonitorResult(db, monitor, await checkMonitor(monitor));
  }
  setHealth(db, "monitor_runner", "ok", `Checked ${due.length} monitor(s).`);
  return due.length;
}

export function monitorFreshness(monitor, now = Date.now()) {
  if (!monitor.active) return "paused";
  if (!monitor.last_checked_at) return "unknown";
  const age = (now - Date.parse(monitor.last_checked_at)) / 1000;
  if (age > monitor.interval_seconds * 3 + 120) return "stale";
  return monitor.status;
}

export function announceDeviceStatus(db, device, previous, status, at) {
  if (!["online", "offline"].includes(status) || previous === status) return;
  const watchers = orgWatchers(db, device.organization_id, [device.assigned_user_id]);
  const offline = status === "offline";
  notifyUsers(db, watchers, {
    title: offline ? `${device.name} went offline` : `${device.name} is back online`,
    body: offline
      ? `The last successful check was ${device.last_connection || "never"}. OSVIA opened an incident if the device is in service.`
      : "The device answered a check again.",
    kind: "device",
    link: `devices/${device.id}`,
    marker: `device-status:${device.id}:${status}:${at}`,
  });
  publish(watchers, "device.status", {
    deviceId: device.id,
    organizationId: device.organization_id,
    name: device.name,
    status,
    previous: previous || "unknown",
    at,
  });
}

export async function applyDeviceCheck(db, deviceId) {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId);
  if (!device) return null;
  if (!device.address || device.source === "meshcentral") return device;
  const reachability = await probe(device.address, device.check_port);
  const checkedAt = nowIso();
  const changed = device.reachability !== reachability;
  transaction(db, () => {
    db.prepare("UPDATE devices SET reachability = ?, last_checked = ?, last_connection = CASE WHEN ? = 'online' THEN ? ELSE last_connection END WHERE id = ?").run(
      reachability, checkedAt, reachability, checkedAt, deviceId,
    );
    recordDeviceStatus(db, deviceId, device.reachability, reachability, "network_check", checkedAt);
    if (reachability === "offline" && changed && !inMaintenance(db, device.organization_id, checkedAt) && device.operational_status === "in_service") {
      openIncident(db, { organizationId: device.organization_id, deviceId, title: `${device.name} stopped responding`, severity: "minor", customerVisible: true });
    }
    if (reachability === "online") resolveIncident(db, "device_id", deviceId, "The device answered a check again.");
  });
  if (changed) announceDeviceStatus(db, device, device.reachability, reachability, checkedAt);
  return db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId);
}

export async function refreshDevices(db) {
  const rows = db.prepare("SELECT id FROM devices WHERE address IS NOT NULL AND trim(address) != '' AND source = 'manual' AND archived_at IS NULL").all();
  for (const row of rows) await applyDeviceCheck(db, row.id);
  return rows.length;
}

export function meshIncidents(db) {
  const rows = db.prepare("SELECT * FROM devices WHERE source = 'meshcentral' AND archived_at IS NULL").all();
  for (const device of rows) {
    if (device.reachability === "offline" && device.operational_status === "in_service" && !inMaintenance(db, device.organization_id)) {
      openIncident(db, { organizationId: device.organization_id, deviceId: device.id, title: `${device.name} agent is disconnected`, severity: "minor", customerVisible: true });
    }
    if (device.reachability === "online") resolveIncident(db, "device_id", device.id, "MeshCentral reports the agent connected again.");
  }
}
