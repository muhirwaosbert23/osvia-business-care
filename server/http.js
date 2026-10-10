import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./errors.js";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
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

export function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65_536) {
        reject(new HttpError(413, "The request is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new HttpError(400, "Send a JSON object."));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, "The request body is not valid JSON."));
      }
    });
    req.on("error", () => reject(new HttpError(400, "The request could not be read.")));
  });
}

export function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function sessionCookie(value, maxAge) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `osvia_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export function clientIp(req) {
  return req.socket?.remoteAddress || "unknown";
}

export function serveStatic(res, publicDir, pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  if (relative.includes("\0")) return sendJson(res, 400, { error: "Bad path." });
  const full = path.resolve(publicDir, relative);
  const root = path.resolve(publicDir);
  if (!full.toLowerCase().startsWith(root.toLowerCase() + path.sep) && full.toLowerCase() !== root.toLowerCase()) {
    return sendJson(res, 403, { error: "Forbidden." });
  }
  const file = fs.existsSync(full) && fs.statSync(full).isFile() ? full : path.join(root, "index.html");
  if (!fs.existsSync(file)) return sendJson(res, 404, { error: "Not found." });
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    ...securityHeaders(),
  });
  res.end(body);
}
