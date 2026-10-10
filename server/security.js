import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

function scryptParams() {
  if (process.execArgv.includes("--test")) {
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
    actual = scryptSync(password, Buffer.from(saltHex, "hex"), Buffer.from(hashHex, "hex").length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

const DUMMY_HASH = hashPassword("osvia-timing-pad");

export function passwordOk(password, stored) {
  const ok = verifyPassword(password, stored || DUMMY_HASH);
  return Boolean(stored) && ok;
}

export function randomId(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function tokensMatch(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
