import net from "node:net";
import { HttpError } from "./errors.js";
import { isPrivateAddress } from "./monitoring.js";

export function parseCoords(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new HttpError(400, "Enter a valid latitude and longitude.");
  }
  return { lat: Math.round(latitude * 1e6) / 1e6, lng: Math.round(longitude * 1e6) / 1e6 };
}

export function googleMapsUrl({ lat, lng, label }) {
  const query = lat != null && lng != null ? `${lat},${lng}` : encodeURIComponent(label || "");
  return `https://www.google.com/maps?q=${query}`;
}

export function googleMapsEmbed({ lat, lng, zoom = 14 }) {
  return `https://www.google.com/maps?q=${lat},${lng}&z=${zoom}&hl=en&output=embed`;
}

export function googleMapsPath(points) {
  const path = points.filter((p) => p.lat != null && p.lng != null).slice(-8).map((p) => `${p.lat},${p.lng}`).join("/");
  return path ? `https://www.google.com/maps/dir/${path}` : null;
}

export function embedZoom(source) {
  return source === "ip" ? 11 : 16;
}

async function readJson(url, fetchImpl, headers = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "OSVIA-Business-Care/1.0 (https://osviatech.com)", ...headers } });
  if (!response.ok) throw new HttpError(502, "The location service did not respond.");
  return response.json();
}

export async function lookupPublicIp(ip, fetchImpl = fetch) {
  const host = String(ip || "").trim();
  if (!host) throw new HttpError(400, "This device has no public address to locate.");
  if (net.isIP(host) && isPrivateAddress(host)) throw new HttpError(400, "Private or local addresses cannot be placed on a public map. Pin the office on the map instead.");
  const data = await readJson(`https://ipwho.is/${encodeURIComponent(host)}`, fetchImpl);
  if (!data?.success || !Number.isFinite(Number(data.latitude)) || !Number.isFinite(Number(data.longitude))) {
    throw new HttpError(404, "No map position is published for that public address.");
  }
  const city = [data.city, data.region, data.country].filter(Boolean).join(", ");
  return {
    ...parseCoords(data.latitude, data.longitude),
    label: city || `Public IP ${host}`,
    accuracyM: 25000,
    ip: host,
    source: "ip",
  };
}

export async function geocodePlace(query, fetchImpl = fetch) {
  const text = String(query || "").trim();
  if (text.length < 3) throw new HttpError(400, "Enter a place name or address, for example Kampala or Plot 4, Industrial Area.");
  if (text.length > 200) throw new HttpError(400, "That place name is too long.");
  const data = await readJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(text)}`, fetchImpl);
  const hit = Array.isArray(data) ? data[0] : null;
  if (!hit) throw new HttpError(404, "That place was not found. Try a clearer address.");
  return { ...parseCoords(hit.lat, hit.lon), label: String(hit.display_name || text).slice(0, 200), accuracyM: 200, source: "manual" };
}

function firstNumber(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    if (obj[key] == null || obj[key] === "") continue;
    const number = Number(obj[key]);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function pairFrom(obj) {
  const lat = firstNumber(obj, ["lat", "latitude", "gpslat", "geoLat", "y"]);
  const lng = firstNumber(obj, ["long", "lon", "lng", "longitude", "gpslong", "gpslon", "geoLon", "x"]);
  if (lat == null || lng == null || (lat === 0 && lng === 0)) return null;
  try {
    return parseCoords(lat, lng);
  } catch {
    return null;
  }
}

function pairFromText(value) {
  const match = String(value || "").trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  try {
    const coords = parseCoords(match[1], match[2]);
    if (coords.lat === 0 && coords.lng === 0) return null;
    return coords;
  } catch {
    return null;
  }
}

function wrapMeshCoords(coords, node) {
  const acc = firstNumber(node, ["acc", "accuracy", "gpsacc"]) ?? firstNumber(node.gps, ["acc", "accuracy"]);
  return {
    ...coords,
    source: "meshcentral",
    label: "MeshCentral agent GPS",
    accuracyM: acc && acc > 0 && acc < 50000 ? Math.round(acc) : 50,
  };
}

export function nodeCoordinates(node) {
  if (!node || typeof node !== "object") return null;
  const buckets = [node, node.gps, node.GPS, node.location, node.loc, node.pos, node.position, node.geo, node.geolocation, node.agent, node.agent?.gps, node.agent?.location, node.info, node.sys];
  for (const bucket of buckets) {
    const coords = typeof bucket === "string" ? pairFromText(bucket) : pairFrom(bucket);
    if (coords) return wrapMeshCoords(coords, node);
  }
  for (const key of ["iploc", "gps", "coord", "coords", "ll"]) {
    const coords = pairFromText(node[key]);
    if (coords) return wrapMeshCoords(coords, node);
  }
  return null;
}

function cleanIp(value) {
  const text = String(value || "").trim().replace(/^\[|\]$/g, "");
  if (net.isIP(text)) return text;
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(text);
  return v4port && net.isIPv4(v4port[1]) ? v4port[1] : "";
}

function pushHosts(list, value) {
  if (value == null || value === "") return;
  if (Array.isArray(value)) {
    for (const item of value) pushHosts(list, item);
    return;
  }
  if (typeof value === "object") {
    for (const key of ["ip", "lastaddr", "host", "hip", "aip", "addr", "wanip", "publicip", "internetip", "extip", "externalip", "pip"]) {
      pushHosts(list, value[key]);
    }
    return;
  }
  for (const part of String(value).split(/[,\s]+/)) {
    const ip = cleanIp(part);
    if (ip) list.push(ip);
  }
}

export function nodePublicIp(node) {
  if (!node || typeof node !== "object") return null;
  const found = [];
  for (const key of ["ip", "lastaddr", "wanip", "publicip", "internetip", "extip", "externalip", "pip", "hip", "aip", "addr", "host"]) {
    pushHosts(found, node[key]);
  }
  pushHosts(found, node.agent);
  pushHosts(found, node.ips);
  for (const ip of found) {
    if (net.isIP(ip) && !isPrivateAddress(ip)) return ip;
  }
  return null;
}
