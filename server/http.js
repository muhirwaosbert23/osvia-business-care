import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./errors.js";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

export class Reply {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export function reply(status, body, headers) {
  return new Reply(status, body, headers);
}

export function securityHeaders() {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  if (process.env.COOKIE_SECURE === "true") headers["Strict-Transport-Security"] = "max-age=31536000";
  return headers;
}

export function sendJson(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...securityHeaders(),
    ...extra,
  });
  res.end(payload);
}

export function sendFile(res, { body, type, filename, inline = false }) {
  const safe = String(filename || "download").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safe}"`,
    "Cache-Control": "no-store",
    ...securityHeaders(),
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  res.end(body);
}

export function startStream(res, { type, filename }) {
  const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${safe}"`,
    "Cache-Control": "no-store",
    ...securityHeaders(),
  });
}

function collect(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) {
      reject(new HttpError(413, `The upload is larger than ${Math.round(limit / 1024 / 1024) || 1} MB.`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, "The request is too large."));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", () => reject(new HttpError(400, "The request could not be read.")));
  });
}

export async function readJson(req) {
  const buffer = await collect(req, 256 * 1024);
  if (!buffer.length) return {};
  const type = String(req.headers["content-type"] || "");
  if (!type.includes("application/json")) throw new HttpError(415, "Send JSON with Content-Type application/json.");
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
}

export function readRaw(req, limit) {
  return collect(req, limit);
}

export function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return "";
      }
    }
  }
  return "";
}

export function sessionCookie(value, maxAge) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `osvia_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export function clientIp(req) {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return req.socket?.remoteAddress || "unknown";
}

export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = req.headers["x-forwarded-host"] && process.env.TRUST_PROXY === "true" ? req.headers["x-forwarded-host"] : req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function serveStatic(res, publicDir, pathname) {
  let relative;
  try {
    relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return sendJson(res, 400, { error: "Bad path." });
  }
  if (relative.includes("\0")) return sendJson(res, 400, { error: "Bad path." });
  const root = path.resolve(publicDir);
  const full = path.resolve(root, relative);
  if (!full.toLowerCase().startsWith(root.toLowerCase() + path.sep) && full.toLowerCase() !== root.toLowerCase()) {
    return sendJson(res, 403, { error: "Forbidden." });
  }
  const exists = fs.existsSync(full) && fs.statSync(full).isFile();
  if (!exists && path.extname(relative)) return sendJson(res, 404, { error: "Not found." });
  const file = exists ? full : path.join(root, "index.html");
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": [".html", ".js", ".css"].includes(path.extname(file)) ? "no-cache" : "public, max-age=300",
    ...securityHeaders(),
  });
  res.end(body);
}
