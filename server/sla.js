const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    }));
  }
  return formatters.get(timeZone);
}

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function isValidTimeZone(timeZone) {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function localParts(ms, timeZone) {
  const parts = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday],
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function offsetMinutes(ms, timeZone) {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export function zonedToUtc(year, month, day, minutesOfDay, timeZone) {
  const naive = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  let guess = naive - offsetMinutes(naive, timeZone) * 60000;
  guess = naive - offsetMinutes(guess, timeZone) * 60000;
  return guess;
}

function clock(text) {
  const [h, m] = String(text).split(":").map(Number);
  return h * 60 + m;
}

function nextLocalMidnight(ms, timeZone) {
  const p = localParts(ms, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, timeZone);
}

function businessWindow(ms, policy, holidays) {
  const p = localParts(ms, policy.timezone);
  const days = String(policy.business_days).split(",").map(Number);
  if (!days.includes(p.weekday)) return null;
  if (policy.exclude_holidays && holidays.has(p.date)) return null;
  return {
    start: zonedToUtc(p.year, p.month, p.day, clock(policy.business_start), policy.timezone),
    end: zonedToUtc(p.year, p.month, p.day, clock(policy.business_end), policy.timezone),
  };
}

export function addBusinessMinutes(startMs, minutes, policy, holidays = new Set()) {
  if (!policy.business_hours_only) return startMs + minutes * 60000;
  let cursor = startMs;
  let remaining = minutes;
  for (let guard = 0; guard < 4000; guard += 1) {
    const window = businessWindow(cursor, policy, holidays);
    if (window && cursor < window.end) {
      if (cursor < window.start) cursor = window.start;
      const available = (window.end - cursor) / 60000;
      if (remaining <= available) return cursor + remaining * 60000;
      remaining -= available;
    }
    cursor = nextLocalMidnight(cursor, policy.timezone);
  }
  throw new Error("The SLA policy has no business hours.");
}

export function businessMinutesBetween(startMs, endMs, policy, holidays = new Set()) {
  if (endMs <= startMs) return 0;
  if (!policy.business_hours_only) return Math.round((endMs - startMs) / 60000);
  let cursor = startMs;
  let total = 0;
  for (let guard = 0; guard < 4000 && cursor < endMs; guard += 1) {
    const window = businessWindow(cursor, policy, holidays);
    if (window) {
      const from = Math.max(cursor, window.start);
      const to = Math.min(endMs, window.end);
      if (to > from) total += (to - from) / 60000;
    }
    cursor = nextLocalMidnight(cursor, policy.timezone);
  }
  return Math.round(total);
}

export function loadHolidays(db) {
  return new Set(db.prepare("SELECT date FROM holidays").all().map((row) => row.date));
}

export function findPolicy(db, planId, priority, category) {
  const rows = db.prepare(`
    SELECT * FROM sla_policies
    WHERE active = 1 AND priority = ? AND (plan_id IS ? OR plan_id IS NULL)
    ORDER BY (plan_id IS NULL), (category IS NULL)
  `).all(priority, planId ?? null);
  return rows.find((row) => !row.category || row.category === category) || null;
}

export function deadlinesFor(db, policy, createdAt) {
  if (!policy) return { responseDue: null, resolutionDue: null };
  const holidays = loadHolidays(db);
  const start = Date.parse(createdAt);
  return {
    responseDue: new Date(addBusinessMinutes(start, policy.response_minutes, policy, holidays)).toISOString(),
    resolutionDue: policy.resolution_minutes
      ? new Date(addBusinessMinutes(start, policy.resolution_minutes, policy, holidays)).toISOString()
      : null,
  };
}

export function slaState(ticket, now = new Date().toISOString()) {
  const response = !ticket.response_due_at
    ? "not_applicable"
    : ticket.first_response_at
      ? (ticket.first_response_at <= ticket.response_due_at ? "met" : "breached")
      : (now > ticket.response_due_at ? "breached" : "pending");
  const finished = ticket.resolved_at;
  const resolution = !ticket.resolution_due_at
    ? "not_offered"
    : ticket.sla_paused_at
      ? "paused"
      : finished
        ? (finished <= ticket.resolution_due_at ? "met" : "breached")
        : (now > ticket.resolution_due_at ? "breached" : "pending");
  return { response, resolution };
}
