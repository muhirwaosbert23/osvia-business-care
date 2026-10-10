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
  const text = String(value ?? "").trim();
  if (!text || text.length > max) {
    throw new HttpError(400, `${label} is required and must be ${max} characters or fewer.`);
  }
  return text;
}

export function optionalText(value, max, label = "This field") {
  const text = String(value ?? "").trim();
  if (text.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return text;
}

export function nullableText(value, max, label) {
  const text = optionalText(value, max, label);
  return text || null;
}

export function assertEnum(value, allowed, label) {
  const text = String(value ?? "");
  if (!allowed.includes(text)) throw new HttpError(400, `Choose a valid ${label}.`);
  return text;
}

export function assertInt(value, label, min, max) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

export function optionalInt(value, label, min, max) {
  if (value === undefined || value === null || value === "") return null;
  return assertInt(value, label, min, max);
}

export function assertDate(value, label) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new HttpError(400, `${label} must be a YYYY-MM-DD date.`);
  }
  return text;
}

export function optionalDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return assertDate(value, label);
}

export function assertDateTime(value, label) {
  const time = Date.parse(String(value || ""));
  if (Number.isNaN(time)) throw new HttpError(400, `${label} must be a valid date and time.`);
  return new Date(time).toISOString();
}

export function assertBool(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "on" ? 1 : 0;
}

export function assertId(value, label = "Record") {
  return assertInt(value, label, 1, 2_147_483_647);
}

export function pageParams(url, sortable = {}, defaultSort = null) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const requested = Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20;
  const limit = Math.min(100, Math.max(1, requested));
  const sortKey = url.searchParams.get("sort");
  const column = sortable[sortKey] || sortable[defaultSort] || null;
  const dir = url.searchParams.get("dir") === "asc" ? "ASC" : "DESC";
  return {
    page,
    limit,
    offset: (page - 1) * limit,
    q: String(url.searchParams.get("q") || "").trim().slice(0, 100),
    orderBy: column ? `${column} ${dir}` : null,
  };
}

export function fieldPicker(body, current = {}) {
  return (key, column, fn, fallback) => {
    if (body[key] !== undefined) return fn(body[key]);
    if (current[column] !== undefined) return current[column];
    if (fallback !== undefined) return fallback;
    return fn(undefined);
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

export function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function addMonths(dateText, months) {
  const [y, m, d] = dateText.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export function reportPeriod(url) {
  const today = todayUtc();
  const from = url.searchParams.get("from") ? assertDate(url.searchParams.get("from"), "From") : `${today.slice(0, 7)}-01`;
  const to = url.searchParams.get("to") ? assertDate(url.searchParams.get("to"), "To") : today;
  if (to < from) throw new HttpError(400, "The end date must be on or after the start date.");
  return { from, to, fromIso: `${from}T00:00:00.000Z`, toIso: `${addDays(to, 1)}T00:00:00.000Z` };
}
