import { HttpError } from "./errors.js";

export function assertEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  return email;
}

export function assertPassword(value) {
  const password = String(value || "");
  if (password.length < 10 || password.length > 200) {
    throw new HttpError(400, "Use a password of at least 10 characters.");
  }
  return password;
}

export function assertText(value, label, max) {
  const text = String(value || "").trim();
  if (!text || text.length > max) {
    throw new HttpError(400, `${label} is required and must be ${max} characters or fewer.`);
  }
  return text;
}

export function optionalText(value, max) {
  const text = String(value || "").trim();
  if (text.length > max) throw new HttpError(400, `Use ${max} characters or fewer.`);
  return text;
}

export function assertEnum(value, allowed, label) {
  const text = String(value || "");
  if (!allowed.includes(text)) throw new HttpError(400, `Choose a valid ${label}.`);
  return text;
}

export function assertInt(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

export function assertDate(value, label) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new HttpError(400, `${label} must be a YYYY-MM-DD date.`);
  return text;
}

export function pageParams(url) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const requested = Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20;
  const limit = Math.min(100, Math.max(1, requested));
  return {
    page,
    limit,
    offset: (page - 1) * limit,
    q: String(url.searchParams.get("q") || "").trim().slice(0, 100),
  };
}

export function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function todayUtc(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
