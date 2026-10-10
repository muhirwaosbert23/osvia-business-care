import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function scryptParams() {
  if (process.execArgv.includes("--test") || process.env.NODE_TEST_CONTEXT) {
    return { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
  }
  return { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
}

export function hashPassword(password) {
  const params = scryptParams();
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  let actual;
  try {
    actual = scryptSync(String(password), Buffer.from(saltHex, "hex"), Buffer.from(hashHex, "hex").length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash;
export function passwordOk(password, stored) {
  dummyHash ||= hashPassword("osvia-timing-pad");
  const ok = verifyPassword(password, stored || dummyHash);
  return Boolean(stored) && ok;
}

export function randomId(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function tokensMatch(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

let appKey = null;

export function initAppSecret(dataDir) {
  if (process.env.APP_SECRET) {
    appKey = createHash("sha256").update(process.env.APP_SECRET).digest();
    return;
  }
  const file = path.join(dataDir, "app-secret.key");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  appKey = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
}

function key() {
  if (!appKey) {
    if (!process.env.APP_SECRET && !process.env.NODE_TEST_CONTEXT) throw new Error("The application secret is not initialized.");
    appKey = createHash("sha256").update(process.env.APP_SECRET || "osvia-test-only-secret").digest();
  }
  return appKey;
}

export function sealSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${body.toString("base64")}`;
}

export function openSecret(sealed) {
  const [version, iv, tag, body] = String(sealed || "").split(":");
  if (version !== "v1") throw new Error("Unknown secret format.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function newTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret, time = Date.now(), step = 30) {
  const counter = Math.floor(time / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret, code, time = Date.now()) {
  const candidate = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(candidate)) return false;
  for (const drift of [-1, 0, 1]) {
    if (tokensMatch(totpCode(secret, time + drift * 30_000), candidate)) return true;
  }
  return false;
}
