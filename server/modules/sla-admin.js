import { requireRole, requireStaff } from "../auth.js";
import { CATEGORIES, PRIORITIES } from "../constants.js";
import { audit } from "../db.js";
import { HttpError } from "../errors.js";
import { reply } from "../http.js";
import { isValidTimeZone } from "../sla.js";
import { assertBool, assertDate, assertEnum, assertId, assertInt, assertText, fieldPicker, nowIso, optionalInt } from "../validate.js";

function mapPolicy(row) {
  return {
    id: row.id,
    name: row.name,
    planId: row.plan_id,
    planName: row.plan_name || "No plan",
    priority: row.priority,
    category: row.category || "",
    responseMinutes: row.response_minutes,
    resolutionMinutes: row.resolution_minutes,
    businessHoursOnly: row.business_hours_only === 1,
    timezone: row.timezone,
    businessStart: row.business_start,
    businessEnd: row.business_end,
    businessDays: row.business_days,
    excludeHolidays: row.exclude_holidays === 1,
    escalateAtPercent: row.escalate_at_percent,
    active: row.active === 1,
  };
}

const POLICY_SELECT = "SELECT s.*, p.name AS plan_name FROM sla_policies s LEFT JOIN service_plans p ON p.id = s.plan_id";

function list({ db, actor }) {
  requireStaff(actor);
  return { items: db.prepare(`${POLICY_SELECT} ORDER BY p.price_ugx IS NULL, p.price_ugx, CASE s.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END`).all().map(mapPolicy) };
}

function time(value, label) {
  const text = String(value || "");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new HttpError(400, `${label} must look like 08:00.`);
  return text;
}

function fields(db, body, current = {}) {
  const pick = fieldPicker(body, current);
  const planId = pick("planId", "plan_id", (v) => (v ? assertId(v, "Plan") : null));
  if (planId && !db.prepare("SELECT 1 FROM service_plans WHERE id = ?").get(planId)) throw new HttpError(400, "Choose a valid plan.");
  const f = {
    name: pick("name", "name", (v) => assertText(v, "Policy name", 120)),
    plan_id: planId,
    priority: pick("priority", "priority", (v) => assertEnum(v, PRIORITIES, "priority")),
    category: pick("category", "category", (v) => (v ? assertEnum(v, CATEGORIES, "category") : null)),
    response_minutes: pick("responseMinutes", "response_minutes", (v) => assertInt(v, "Response target (minutes)", 1, 100000)),
    resolution_minutes: pick("resolutionMinutes", "resolution_minutes", (v) => optionalInt(v, "Resolution target (minutes)", 1, 500000)),
    business_hours_only: pick("businessHoursOnly", "business_hours_only", assertBool, 1),
    timezone: pick("timezone", "timezone", (v) => String(v), "Africa/Kampala"),
    business_start: pick("businessStart", "business_start", (v) => time(v, "Business start"), "08:00"),
    business_end: pick("businessEnd", "business_end", (v) => time(v, "Business end"), "17:00"),
    business_days: pick("businessDays", "business_days", (v) => {
      const days = [...new Set(String(v).split(",").map((d) => Number(d.trim())))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
      if (!days.length) throw new HttpError(400, "Choose at least one business day (1 = Monday, 7 = Sunday).");
      return days.join(",");
    }, "1,2,3,4,5"),
    exclude_holidays: pick("excludeHolidays", "exclude_holidays", assertBool, 1),
    escalate_at_percent: pick("escalateAtPercent", "escalate_at_percent", (v) => assertInt(v, "Escalate at (%)", 1, 100), 75),
    active: pick("active", "active", assertBool, 1),
  };
  if (!isValidTimeZone(f.timezone)) throw new HttpError(400, "Choose a valid time zone such as Africa/Kampala.");
  if (f.business_hours_only && f.business_end <= f.business_start) throw new HttpError(400, "Business hours must end after they start.");
  return f;
}

function create({ db, actor, body }) {
  requireRole(actor, "admin");
  const f = fields(db, body);
  const keys = Object.keys(f);
  const info = db.prepare(`INSERT INTO sla_policies (${keys.join(", ")}, created_at) VALUES (${keys.map(() => "?").join(", ")}, ?)`).run(...keys.map((k) => f[k]), nowIso());
  audit(db, actor.id, "sla_policy.create", "sla_policy", info.lastInsertRowid, null, null, actor.ip);
  return reply(201, { policy: mapPolicy(db.prepare(`${POLICY_SELECT} WHERE s.id = ?`).get(info.lastInsertRowid)) });
}

function update({ db, actor, params, body }) {
  requireRole(actor, "admin");
  const row = db.prepare("SELECT * FROM sla_policies WHERE id = ?").get(params.id);
  if (!row) throw new HttpError(404, "Not found.");
  const f = fields(db, body, row);
  const keys = Object.keys(f);
  db.prepare(`UPDATE sla_policies SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => f[k]), row.id);
  audit(db, actor.id, "sla_policy.update", "sla_policy", row.id, null, null, actor.ip);
  return { policy: mapPolicy(db.prepare(`${POLICY_SELECT} WHERE s.id = ?`).get(row.id)), note: "New targets apply to tickets created or reprioritized from now on." };
}

function listHolidays({ db, actor }) {
  requireStaff(actor);
  return { items: db.prepare("SELECT * FROM holidays ORDER BY date").all() };
}

function addHoliday({ db, actor, body }) {
  requireRole(actor, "admin");
  const date = assertDate(body.date, "Date");
  const info = db.prepare("INSERT INTO holidays (date, name) VALUES (?, ?)").run(date, assertText(body.name, "Holiday name", 120));
  audit(db, actor.id, "holiday.create", "holiday", info.lastInsertRowid, null, { date }, actor.ip);
  return reply(201, { id: Number(info.lastInsertRowid) });
}

function deleteHoliday({ db, actor, params }) {
  requireRole(actor, "admin");
  const row = db.prepare("SELECT * FROM holidays WHERE id = ?").get(params.id);
  if (!row) throw new HttpError(404, "Not found.");
  db.prepare("DELETE FROM holidays WHERE id = ?").run(row.id);
  audit(db, actor.id, "holiday.delete", "holiday", row.id, null, { date: row.date }, actor.ip);
  return { ok: true };
}

export const routes = [
  ["GET", "/api/sla-policies", list],
  ["POST", "/api/sla-policies", create],
  ["PATCH", "/api/sla-policies/:id", update],
  ["GET", "/api/holidays", listHolidays],
  ["POST", "/api/holidays", addHoliday],
  ["DELETE", "/api/holidays/:id", deleteHoliday],
];
