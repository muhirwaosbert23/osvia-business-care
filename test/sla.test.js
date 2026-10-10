import assert from "node:assert/strict";
import { test } from "node:test";
import { addBusinessMinutes, businessMinutesBetween, slaState, zonedToUtc } from "../server/sla.js";

const policy = { business_hours_only: 1, timezone: "Africa/Kampala", business_start: "08:00", business_end: "17:00", business_days: "1,2,3,4,5", exclude_holidays: 1 };
const kampala = (text) => Date.parse(`${text}+03:00`);
const iso = (ms) => new Date(ms).toISOString();

test("Kampala is UTC+3 all year", () => {
  assert.equal(iso(zonedToUtc(2026, 1, 15, 8 * 60, "Africa/Kampala")), "2026-01-15T05:00:00.000Z");
  assert.equal(iso(zonedToUtc(2026, 7, 15, 8 * 60, "Africa/Kampala")), "2026-07-15T05:00:00.000Z");
});

test("Friday 16:30 plus 240 business minutes lands on Monday 11:30", () => {
  const due = addBusinessMinutes(kampala("2026-10-16T16:30:00"), 240, policy);
  assert.equal(iso(due), iso(kampala("2026-10-19T11:30:00")));
});

test("tickets opened before business hours start counting at 08:00", () => {
  const due = addBusinessMinutes(kampala("2026-10-14T06:10:00"), 60, policy);
  assert.equal(iso(due), iso(kampala("2026-10-14T09:00:00")));
});

test("tickets opened after hours roll to the next business day", () => {
  const due = addBusinessMinutes(kampala("2026-10-14T19:45:00"), 30, policy);
  assert.equal(iso(due), iso(kampala("2026-10-15T08:30:00")));
});

test("public holidays are skipped", () => {
  const holidays = new Set(["2026-10-09"]);
  const due = addBusinessMinutes(kampala("2026-10-08T16:00:00"), 120, policy, holidays);
  assert.equal(iso(due), iso(kampala("2026-10-12T09:00:00")));
  const ignoring = addBusinessMinutes(kampala("2026-10-08T16:00:00"), 120, { ...policy, exclude_holidays: 0 }, holidays);
  assert.equal(iso(ignoring), iso(kampala("2026-10-09T09:00:00")));
});

test("a 24/7 policy counts wall-clock time", () => {
  const due = addBusinessMinutes(kampala("2026-10-17T23:00:00"), 120, { ...policy, business_hours_only: 0 });
  assert.equal(iso(due), iso(kampala("2026-10-18T01:00:00")));
});

test("business minutes between two times ignores nights and weekends", () => {
  assert.equal(businessMinutesBetween(kampala("2026-10-16T16:30:00"), kampala("2026-10-19T11:30:00"), policy), 240);
  assert.equal(businessMinutesBetween(kampala("2026-10-17T09:00:00"), kampala("2026-10-18T17:00:00"), policy), 0);
});

test("addBusinessMinutes and businessMinutesBetween agree", () => {
  const start = kampala("2026-10-13T10:17:00");
  for (const minutes of [1, 59, 480, 540, 541, 2000]) {
    assert.equal(businessMinutesBetween(start, addBusinessMinutes(start, minutes, policy), policy), minutes);
  }
});

test("SLA state reports met, breached, pending, paused and not offered", () => {
  const base = { response_due_at: "2026-10-14T10:00:00.000Z", resolution_due_at: "2026-10-15T10:00:00.000Z" };
  assert.deepEqual(slaState({ ...base, first_response_at: "2026-10-14T09:00:00.000Z" }, "2026-10-14T12:00:00.000Z"), { response: "met", resolution: "pending" });
  assert.deepEqual(slaState({ ...base }, "2026-10-14T12:00:00.000Z"), { response: "breached", resolution: "pending" });
  assert.equal(slaState({ ...base, sla_paused_at: "2026-10-14T11:00:00.000Z" }, "2026-10-16T00:00:00.000Z").resolution, "paused");
  assert.equal(slaState({ response_due_at: null, resolution_due_at: null }).response, "not_applicable");
  assert.equal(slaState({ response_due_at: base.response_due_at, resolution_due_at: null }).resolution, "not_offered");
});
