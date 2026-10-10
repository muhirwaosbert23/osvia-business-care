import { embedZoom, googleMapsEmbed, googleMapsPath, googleMapsUrl, lookupPublicIp, parseCoords } from "./geo.js";
import { nowIso } from "./validate.js";

const MOVE_METERS = { ip: 8000, meshcentral: 250, manual: 20, gps: 20 };

function toRad(value) {
  return (value * Math.PI) / 180;
}

export function metersBetween(a, b) {
  const earth = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function mapLocation(row) {
  if (row.last_lat == null || row.last_lng == null) return null;
  const loc = {
    lat: row.last_lat,
    lng: row.last_lng,
    at: row.last_location_at,
    source: row.last_location_source,
    label: row.last_location_label || "",
    accuracyM: row.last_location_accuracy,
  };
  loc.mapsUrl = googleMapsUrl(loc);
  loc.embedUrl = googleMapsEmbed({ ...loc, zoom: embedZoom(loc.source) });
  return loc;
}

export function saveLocation(db, device, { lat, lng, source, label = null, accuracyM = null, ip = null, actorId = null }) {
  const coords = parseCoords(lat, lng);
  const previous = device.last_lat != null ? { lat: device.last_lat, lng: device.last_lng } : null;
  const moved = !previous || metersBetween(previous, coords) >= (MOVE_METERS[source] || 50);
  const at = nowIso();
  const text = label ? String(label).slice(0, 200) : null;
  db.prepare(`
    UPDATE devices SET last_lat = ?, last_lng = ?, last_location_at = ?, last_location_source = ?, last_location_label = ?, last_location_accuracy = ?, last_location_ip = ?
    WHERE id = ?
  `).run(coords.lat, coords.lng, at, source, text, accuracyM, ip, device.id);
  device.last_lat = coords.lat;
  device.last_lng = coords.lng;
  device.last_location_at = at;
  device.last_location_source = source;
  device.last_location_label = text;
  device.last_location_accuracy = accuracyM;
  device.last_location_ip = ip;
  if (moved) {
    db.prepare(`
      INSERT INTO location_events (device_id, lat, lng, accuracy_m, source, label, ip, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(device.id, coords.lat, coords.lng, accuracyM, source, text, ip, actorId, at);
  }
  return { ...mapLocation({ last_lat: coords.lat, last_lng: coords.lng, last_location_at: at, last_location_source: source, last_location_label: text, last_location_accuracy: accuracyM }), recorded: moved };
}

export function locationHistory(db, deviceId) {
  const items = db.prepare(`
    SELECT e.*, u.name AS actor_name FROM location_events e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.device_id = ? ORDER BY e.id DESC LIMIT 50
  `).all(deviceId).map((e) => ({
    id: e.id,
    lat: e.lat,
    lng: e.lng,
    accuracyM: e.accuracy_m,
    source: e.source,
    label: e.label || "",
    ip: e.ip || "",
    actorName: e.actor_name || (e.source === "meshcentral" ? "MeshCentral" : "System"),
    at: e.created_at,
    mapsUrl: googleMapsUrl(e),
  }));
  return { items, pathUrl: googleMapsPath([...items].reverse()) };
}

export function shouldApplyDetected(device, incoming) {
  if (!incoming) return false;
  if (incoming.source === "meshcentral") return true;
  if (incoming.source === "ip" && device.last_location_source && device.last_location_source !== "ip") return false;
  if (incoming.source === "ip" && incoming.ip && device.last_location_ip === incoming.ip && device.last_lat != null) return false;
  return true;
}

export async function locateFromPublicIp(db, device, ip, fetchImpl) {
  const found = await lookupPublicIp(ip, fetchImpl);
  if (!shouldApplyDetected(device, found)) return null;
  return saveLocation(db, device, { ...found, actorId: null });
}

export async function refreshDeviceLocations(db, { lookupFetch = fetch, limit = 25 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM devices
    WHERE archived_at IS NULL
      AND (
        (last_lat IS NULL AND ((address IS NOT NULL AND trim(address) != '') OR (last_seen_ip IS NOT NULL AND trim(last_seen_ip) != '')))
        OR (last_seen_ip IS NOT NULL AND last_seen_ip != '' AND last_seen_ip IS NOT last_location_ip AND COALESCE(last_location_source, '') NOT IN ('manual', 'gps', 'meshcentral'))
      )
    ORDER BY CASE reachability WHEN 'online' THEN 0 ELSE 1 END, id
    LIMIT ?
  `).all(limit);
  let located = 0;
  let skipped = 0;
  for (const row of rows) {
    const ip = row.last_seen_ip || row.address;
    try {
      const saved = await locateFromPublicIp(db, row, ip, lookupFetch);
      if (saved) located += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { checked: rows.length, located, skipped };
}
