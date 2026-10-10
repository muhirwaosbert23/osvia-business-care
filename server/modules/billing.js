import { assertOrgAccess, isStaff, requireOperationalOrg, requireRole, scopeOrgId } from "../auth.js";
import { PAYMENT_METHODS, SUBSCRIPTION_STATUSES } from "../constants.js";
import { audit, changes, getSetting, transaction } from "../db.js";
import { HttpError } from "../errors.js";
import { reply, sendFile } from "../http.js";
import { customerAdminIds, notifyUsers, staffIds } from "../notify.js";
import { buildPdf } from "../pdf.js";
import { addDays, addMonths, assertBool, assertDate, assertEnum, assertId, assertInt, assertText, fieldPicker, nowIso, nullableText, optionalText, pageParams, todayUtc } from "../validate.js";
import { mustOrg } from "./organizations.js";

const money = (amount, currency = "UGX") => `${currency} ${Number(amount).toLocaleString("en-US")}`;

function requireBillingAccess(actor) {
  if (actor.role !== "admin" && actor.role !== "customer_admin") throw new HttpError(403, "Billing is available to administrators.");
}

function mapPlan(row) {
  return {
    id: row.id,
    name: row.name,
    price: row.price_ugx,
    currency: row.currency,
    billingPeriodMonths: row.billing_period_months,
    deviceLimit: row.device_limit,
    monitorLimit: row.monitor_limit,
    supportHours: row.support_hours,
    responseTargetHours: row.response_target_hours,
    onsiteVisits: row.onsite_visits,
    remoteSupport: row.remote_support === 1,
    description: row.description,
    active: row.active === 1,
  };
}

function listPlans({ db, actor }) {
  const rows = db.prepare(`SELECT * FROM service_plans ${actor.role === "admin" ? "" : "WHERE active = 1"} ORDER BY price_ugx`).all();
  return { items: rows.map(mapPlan) };
}

function planFields(body, current = {}) {
  const pick = fieldPicker(body, current);
  return {
    name: pick("name", "name", (v) => assertText(v, "Plan name", 80)),
    price_ugx: pick("price", "price_ugx", (v) => assertInt(v, "Price", 1, 1_000_000_000)),
    billing_period_months: pick("billingPeriodMonths", "billing_period_months", (v) => assertInt(v, "Billing period (months)", 1, 24), 1),
    device_limit: pick("deviceLimit", "device_limit", (v) => assertInt(v, "Device limit", 1, 100000)),
    monitor_limit: pick("monitorLimit", "monitor_limit", (v) => assertInt(v, "Monitor limit", 0, 10000), 2),
    support_hours: pick("supportHours", "support_hours", (v) => assertInt(v, "Support hours", 0, 1000)),
    response_target_hours: pick("responseTargetHours", "response_target_hours", (v) => assertInt(v, "Response target (hours)", 1, 720)),
    onsite_visits: pick("onsiteVisits", "onsite_visits", (v) => assertInt(v, "On-site visits", 0, 100), 0),
    remote_support: pick("remoteSupport", "remote_support", assertBool, 1),
    description: pick("description", "description", (v) => assertText(v, "Description", 1000)),
    active: pick("active", "active", assertBool, 1),
  };
}

function createPlan({ db, actor, body }) {
  requireRole(actor, "admin");
  const f = planFields(body);
  const keys = Object.keys(f);
  const info = db.prepare(`INSERT INTO service_plans (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => f[k]));
  audit(db, actor.id, "plan.create", "service_plan", info.lastInsertRowid, null, { name: f.name, price: f.price_ugx }, actor.ip);
  return reply(201, { plan: mapPlan(db.prepare("SELECT * FROM service_plans WHERE id = ?").get(info.lastInsertRowid)) });
}

function updatePlan({ db, actor, params, body }) {
  requireRole(actor, "admin");
  const row = db.prepare("SELECT * FROM service_plans WHERE id = ?").get(params.id);
  if (!row) throw new HttpError(404, "Not found.");
  const f = planFields(body, row);
  const keys = Object.keys(f);
  db.prepare(`UPDATE service_plans SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => f[k]), row.id);
  audit(db, actor.id, "plan.update", "service_plan", row.id, null, { changes: changes(row, f, keys), reason: nullableText(body.reason, 300, "Reason") }, actor.ip);
  return { plan: mapPlan(db.prepare("SELECT * FROM service_plans WHERE id = ?").get(row.id)) };
}

function subscriptionEvent(db, organizationId, from, to, planId, actorId, note) {
  db.prepare("INSERT INTO subscription_events (organization_id, from_status, to_status, plan_id, actor_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(organizationId, from, to, planId, actorId, note, nowIso());
}

function changeSubscription({ db, actor, params, body }) {
  requireRole(actor, "admin");
  const org = mustOrg(db, params.id);
  const planId = body.planId === undefined ? org.plan_id : (body.planId ? assertId(body.planId, "Plan") : null);
  if (planId && !db.prepare("SELECT 1 FROM service_plans WHERE id = ?").get(planId)) throw new HttpError(400, "Choose a valid plan.");
  let status = org.subscription_status;
  if (body.status !== undefined) {
    status = assertEnum(body.status, SUBSCRIPTION_STATUSES, "subscription status");
    if (status === "active" && org.subscription_status !== "active") {
      throw new HttpError(400, "A subscription becomes active only when a payment for its invoice is verified.");
    }
  }
  const note = nullableText(body.note, 300, "Note");
  transaction(db, () => {
    db.prepare("UPDATE organizations SET plan_id = ?, subscription_status = ? WHERE id = ?").run(planId, status, org.id);
    subscriptionEvent(db, org.id, org.subscription_status, status, planId, actor.id, note || (planId !== org.plan_id ? "Plan changed" : null));
    audit(db, actor.id, "subscription.update", "organization", org.id, org.id, {
      changes: changes(org, { plan_id: planId, subscription_status: status }, ["plan_id", "subscription_status"]),
      reason: note,
    }, actor.ip);
    if (status !== org.subscription_status) {
      notifyUsers(db, customerAdminIds(db, org.id), { title: `Subscription ${status.replace("_", " ")}`, body: note || "Your OSVIA subscription status changed.", kind: "billing", link: "billing" });
    }
  });
  return { ok: true };
}

function requestPlan({ db, actor, body }) {
  requireRole(actor, "customer_admin");
  requireOperationalOrg(db, actor);
  const planId = assertId(body.planId, "Plan");
  const plan = db.prepare("SELECT * FROM service_plans WHERE id = ? AND active = 1").get(planId);
  if (!plan) throw new HttpError(400, "Choose an available plan.");
  const org = mustOrg(db, actor.organizationId);
  transaction(db, () => {
    subscriptionEvent(db, org.id, org.subscription_status, "requested", planId, actor.id, optionalText(body.note, 300, "Note") || null);
    audit(db, actor.id, "subscription.request", "organization", org.id, org.id, { planId }, actor.ip);
    notifyUsers(db, staffIds(db, ["admin"]), { title: `${org.name} requested the ${plan.name} plan`, body: "Assign the plan and issue an invoice from the organization's billing page.", kind: "billing", link: `organizations/${org.id}` });
  });
  return { ok: true, message: "OSVIA has your request and will issue an invoice." };
}

function subscriptionHistory({ db, actor, params }) {
  requireBillingAccess(actor);
  assertOrgAccess(actor, params.id);
  const rows = db.prepare(`
    SELECT e.*, p.name AS plan_name, u.name AS actor_name FROM subscription_events e LEFT JOIN service_plans p ON p.id = e.plan_id LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.organization_id = ? ORDER BY e.id DESC LIMIT 100
  `).all(params.id);
  return { items: rows.map((e) => ({ id: e.id, fromStatus: e.from_status, toStatus: e.to_status, planName: e.plan_name || "", actorName: e.actor_name || "System", note: e.note || "", createdAt: e.created_at })) };
}

const INVOICE_SELECT = `
  SELECT i.*, o.name AS organization_name, p.name AS plan_name,
    (SELECT COALESCE(SUM(amount_ugx), 0) FROM payments WHERE invoice_id = i.id AND status = 'verified') AS paid_amount,
    (SELECT COUNT(*) FROM payments WHERE invoice_id = i.id AND status = 'pending') AS pending_payments
  FROM invoices i JOIN organizations o ON o.id = i.organization_id LEFT JOIN service_plans p ON p.id = i.plan_id
`;

function mapInvoice(row) {
  return {
    id: row.id,
    number: row.number,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    planName: row.plan_name || "",
    description: row.description,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    overdue: row.status === "issued" && row.due_date < todayUtc(),
    paidAmount: row.paid_amount,
    balance: Math.max(0, row.amount - row.paid_amount),
    pendingPayments: row.pending_payments,
    issuedAt: row.issued_at,
    dueDate: row.due_date,
    paidAt: row.paid_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason || "",
  };
}

function billingScope(actor, url, alias) {
  requireBillingAccess(actor);
  if (!isStaff(actor)) return { sql: `${alias}.organization_id = ?`, args: [actor.organizationId] };
  const requested = url.searchParams.get("organizationId");
  return requested ? { sql: `${alias}.organization_id = ?`, args: [scopeOrgId(actor, requested)] } : { sql: "1 = 1", args: [] };
}

function listInvoices({ db, actor, url }) {
  const { page, limit, offset } = pageParams(url);
  const s = billingScope(actor, url, "i");
  const where = [s.sql];
  const args = [...s.args];
  const status = url.searchParams.get("status");
  if (status === "overdue") where.push("i.status = 'issued' AND i.due_date < ?"), args.push(todayUtc());
  else if (status) where.push("i.status = ?"), args.push(assertEnum(status, ["issued", "paid", "void"], "status"));
  const clause = where.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) AS n FROM invoices i WHERE ${clause}`).get(...args).n;
  const items = db.prepare(`${INVOICE_SELECT} WHERE ${clause} ORDER BY i.issued_at DESC, i.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(mapInvoice);
  return { items, page, pageSize: limit, total };
}

function loadInvoice(db, actor, id) {
  requireBillingAccess(actor);
  const row = db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(id);
  if (!row || (!isStaff(actor) && row.organization_id !== actor.organizationId)) throw new HttpError(404, "Not found.");
  return row;
}

function nextInvoiceNumber(db) {
  const prefix = getSetting(db, "invoice_prefix", "INV").replace(/[^A-Z0-9]/gi, "").slice(0, 8) || "INV";
  const year = todayUtc().slice(0, 4);
  const stem = `${prefix}-${year}-`;
  const last = db.prepare("SELECT number FROM invoices WHERE number LIKE ? ORDER BY length(number) DESC, number DESC LIMIT 1").get(`${stem}%`);
  const next = last ? Number(last.number.slice(stem.length)) + 1 : 1;
  return `${stem}${String(next).padStart(4, "0")}`;
}

function createInvoice({ db, actor, body }) {
  requireRole(actor, "admin");
  const organizationId = scopeOrgId(actor, body.organizationId);
  const org = mustOrg(db, organizationId);
  const planId = body.planId ? assertId(body.planId, "Plan") : org.plan_id;
  const plan = planId ? db.prepare("SELECT * FROM service_plans WHERE id = ?").get(planId) : null;
  if (planId && !plan) throw new HttpError(400, "Choose a valid plan.");
  const periodStart = body.periodStart ? assertDate(body.periodStart, "Period start") : (org.renewal_date && org.renewal_date >= todayUtc() ? org.renewal_date : todayUtc());
  const periodEnd = body.periodEnd ? assertDate(body.periodEnd, "Period end") : addMonths(periodStart, plan?.billing_period_months || 1);
  if (periodEnd <= periodStart) throw new HttpError(400, "The period must end after it starts.");
  const amount = body.amount === undefined || body.amount === "" ? plan?.price_ugx : assertInt(body.amount, "Amount", 1, 1_000_000_000);
  if (!amount) throw new HttpError(400, "Enter an amount or choose a plan.");
  const description = body.description ? assertText(body.description, "Description", 300) : `${plan ? `${plan.name} plan` : "OSVIA services"}, ${periodStart} to ${periodEnd}`;
  const dueDate = body.dueDate ? assertDate(body.dueDate, "Due date") : addDays(todayUtc(), Number(getSetting(db, "invoice_due_days", "14")) || 14);
  const id = transaction(db, () => {
    const number = nextInvoiceNumber(db);
    const info = db.prepare(`
      INSERT INTO invoices (number, organization_id, plan_id, description, period_start, period_end, amount, currency, status, issued_at, due_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?)
    `).run(number, organizationId, planId, description, periodStart, periodEnd, amount, plan?.currency || "UGX", nowIso(), dueDate, actor.id);
    const invoiceId = Number(info.lastInsertRowid);
    if (planId && planId !== org.plan_id) {
      db.prepare("UPDATE organizations SET plan_id = ? WHERE id = ?").run(planId, organizationId);
      subscriptionEvent(db, organizationId, org.subscription_status, org.subscription_status, planId, actor.id, `Plan set with invoice ${number}`);
    }
    audit(db, actor.id, "invoice.create", "invoice", invoiceId, organizationId, { number, amount }, actor.ip);
    notifyUsers(db, customerAdminIds(db, organizationId), { title: `Invoice ${number}`, body: `${money(amount, plan?.currency)} due ${dueDate}. ${description}`, kind: "billing", link: "billing" });
    return invoiceId;
  });
  return reply(201, { invoice: mapInvoice(loadInvoice(db, actor, id)) });
}

function voidInvoice({ db, actor, params, body }) {
  requireRole(actor, "admin");
  const row = loadInvoice(db, actor, params.id);
  if (row.status !== "issued") throw new HttpError(400, "Only an unpaid invoice can be voided.");
  if (row.paid_amount > 0) throw new HttpError(400, "This invoice has verified payments and cannot be voided.");
  const reason = assertText(body.reason, "Reason", 300);
  db.prepare("UPDATE invoices SET status = 'void', voided_at = ?, void_reason = ? WHERE id = ?").run(nowIso(), reason, row.id);
  audit(db, actor.id, "invoice.void", "invoice", row.id, row.organization_id, { reason }, actor.ip);
  return { invoice: mapInvoice(loadInvoice(db, actor, row.id)) };
}

function invoicePdf({ db, actor, params, res }) {
  const row = loadInvoice(db, actor, params.id);
  const org = mustOrg(db, row.organization_id);
  const payments = db.prepare("SELECT * FROM payments WHERE invoice_id = ? AND status = 'verified' ORDER BY confirmed_at").all(row.id);
  const lines = [
    `Invoice number: ${row.number}`,
    `Issued: ${row.issued_at.slice(0, 10)}    Due: ${row.due_date}`,
    `Status: ${row.status === "issued" ? (row.due_date < todayUtc() ? "OVERDUE" : "UNPAID") : row.status.toUpperCase()}`,
    "",
    { heading: "Bill to" },
    org.name,
    `${org.contact_name} <${org.contact_email}>`,
    org.location || "",
    "",
    { heading: "Details" },
    row.description,
    `Service period: ${row.period_start} to ${row.period_end}`,
    `Amount: ${money(row.amount, row.currency)}`,
    `Verified payments: ${money(row.paid_amount, row.currency)}`,
    `Balance due: ${money(Math.max(0, row.amount - row.paid_amount), row.currency)}`,
    "",
    ...(payments.length ? [{ heading: "Payments received" }, ...payments.map((p) => `${p.confirmed_at.slice(0, 10)}  ${money(p.amount_ugx, p.currency)}  ${p.method.replaceAll("_", " ")}  ref ${p.reference}`), ""] : []),
    "Pay by bank transfer or mobile money and quote the invoice number as the reference.",
    "OSVIA confirms every payment manually before it is applied.",
  ];
  audit(db, actor.id, "invoice.pdf", "invoice", row.id, row.organization_id, null, actor.ip);
  sendFile(res, { body: buildPdf("Invoice", lines), type: "application/pdf", filename: `${row.number}.pdf` });
}

function mapPayment(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number || "",
    amount: row.amount_ugx,
    currency: row.currency,
    method: row.method,
    reference: row.reference,
    note: row.note || "",
    status: row.status,
    recordedBy: row.recorder,
    verifiedBy: row.verifier || "",
    verifiedAt: row.confirmed_at,
    reconciliationNote: row.reconciliation_note || "",
    rejectedReason: row.rejected_reason || "",
    createdAt: row.created_at,
  };
}

const PAYMENT_SELECT = `
  SELECT p.*, o.name AS organization_name, i.number AS invoice_number, r.name AS recorder, v.name AS verifier
  FROM payments p JOIN organizations o ON o.id = p.organization_id LEFT JOIN invoices i ON i.id = p.invoice_id
  JOIN users r ON r.id = p.recorded_by LEFT JOIN users v ON v.id = p.confirmed_by
`;

function listPayments({ db, actor, url }) {
  const { page, limit, offset } = pageParams(url);
  const s = billingScope(actor, url, "p");
  const where = [s.sql];
  const args = [...s.args];
  if (url.searchParams.get("status")) where.push("p.status = ?"), args.push(assertEnum(url.searchParams.get("status"), ["pending", "verified", "rejected"], "status"));
  const clause = where.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) AS n FROM payments p WHERE ${clause}`).get(...args).n;
  const items = db.prepare(`${PAYMENT_SELECT} WHERE ${clause} ORDER BY p.status = 'pending' DESC, p.created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(mapPayment);
  return { items, page, pageSize: limit, total };
}

function recordPayment({ db, actor, body }) {
  requireBillingAccess(actor);
  requireOperationalOrg(db, actor);
  const organizationId = scopeOrgId(actor, body.organizationId);
  mustOrg(db, organizationId);
  let invoiceId = null;
  if (body.invoiceId) {
    invoiceId = assertId(body.invoiceId, "Invoice");
    const invoice = db.prepare("SELECT * FROM invoices WHERE id = ? AND organization_id = ?").get(invoiceId, organizationId);
    if (!invoice) throw new HttpError(400, "That invoice belongs to another organization.");
    if (invoice.status !== "issued") throw new HttpError(400, "That invoice is not awaiting payment.");
  }
  const amount = assertInt(body.amount, "Amount", 1, 1_000_000_000);
  const method = assertEnum(body.method, PAYMENT_METHODS, "payment method");
  const reference = assertText(body.reference, "Transaction reference", 120);
  if (db.prepare("SELECT 1 FROM payments WHERE organization_id = ? AND method = ? AND reference = ? AND status != 'rejected'").get(organizationId, method, reference)) {
    throw new HttpError(409, "A payment with this reference is already recorded.");
  }
  const id = transaction(db, () => {
    const info = db.prepare(`
      INSERT INTO payments (organization_id, invoice_id, amount_ugx, currency, method, reference, note, status, recorded_by, created_at)
      VALUES (?, ?, ?, 'UGX', ?, ?, ?, 'pending', ?, ?)
    `).run(organizationId, invoiceId, amount, method, reference, nullableText(body.note, 500, "Note"), actor.id, nowIso());
    const paymentId = Number(info.lastInsertRowid);
    audit(db, actor.id, "payment.record", "payment", paymentId, organizationId, { amount, method }, actor.ip);
    notifyUsers(db, staffIds(db, ["admin"]), { title: "Payment awaiting verification", body: `${money(amount)} by ${method.replaceAll("_", " ")}, reference ${reference}.`, kind: "billing", link: "billing" });
    return paymentId;
  });
  return reply(201, { payment: mapPayment(db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(id)), message: "Recorded as pending. OSVIA will verify it against the bank or mobile-money statement." });
}

function verifyPayment({ db, actor, params, body }) {
  requireRole(actor, "admin");
  const row = db.prepare("SELECT * FROM payments WHERE id = ?").get(params.id);
  if (!row) throw new HttpError(404, "Not found.");
  if (row.status !== "pending") throw new HttpError(400, "Only a pending payment can be verified.");
  if (body.confirmReceived !== true) throw new HttpError(400, "Confirm that the money appears in the OSVIA bank or mobile-money statement.");
  const note = assertText(body.reconciliationNote, "Reconciliation note", 500);
  const now = nowIso();
  transaction(db, () => {
    db.prepare("UPDATE payments SET status = 'verified', confirmed_by = ?, confirmed_at = ?, reconciliation_note = ? WHERE id = ? AND status = 'pending'").run(actor.id, now, note, row.id);
    audit(db, actor.id, "payment.verify", "payment", row.id, row.organization_id, { amount: row.amount_ugx, reason: note, changes: { status: ["pending", "verified"] } }, actor.ip);
    if (row.invoice_id) {
      const invoice = db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(row.invoice_id);
      if (invoice.status === "issued" && invoice.paid_amount >= invoice.amount) {
        db.prepare("UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?").run(now, invoice.id);
        const org = mustOrg(db, invoice.organization_id);
        const renewal = !org.renewal_date || invoice.period_end > org.renewal_date ? invoice.period_end : org.renewal_date;
        db.prepare("UPDATE organizations SET subscription_status = 'active', plan_id = COALESCE(?, plan_id), renewal_date = ? WHERE id = ?").run(invoice.plan_id, renewal, org.id);
        subscriptionEvent(db, org.id, org.subscription_status, "active", invoice.plan_id ?? org.plan_id, actor.id, `Invoice ${invoice.number} paid`);
        audit(db, actor.id, "invoice.paid", "invoice", invoice.id, org.id, null, actor.ip);
      }
    }
    notifyUsers(db, customerAdminIds(db, row.organization_id), { title: "Payment verified", body: `OSVIA verified your payment of ${money(row.amount_ugx, row.currency)} (reference ${row.reference}).`, kind: "billing", link: "billing" });
  });
  return { payment: mapPayment(db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(row.id)) };
}

function rejectPayment({ db, actor, params, body }) {
  requireRole(actor, "admin");
  const row = db.prepare("SELECT * FROM payments WHERE id = ?").get(params.id);
  if (!row) throw new HttpError(404, "Not found.");
  if (row.status !== "pending") throw new HttpError(400, "Only a pending payment can be rejected.");
  const reason = assertText(body.reason, "Reason", 300);
  transaction(db, () => {
    db.prepare("UPDATE payments SET status = 'rejected', rejected_reason = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?").run(reason, actor.id, nowIso(), row.id);
    audit(db, actor.id, "payment.reject", "payment", row.id, row.organization_id, { reason }, actor.ip);
    notifyUsers(db, customerAdminIds(db, row.organization_id), { title: "Payment could not be verified", body: `Reference ${row.reference}: ${reason}`, kind: "billing", link: "billing" });
  });
  return { payment: mapPayment(db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(row.id)) };
}

function receiptPdf({ db, actor, params, res }) {
  requireBillingAccess(actor);
  const row = db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(params.id);
  if (!row || (!isStaff(actor) && row.organization_id !== actor.organizationId)) throw new HttpError(404, "Not found.");
  if (row.status !== "verified") throw new HttpError(400, "A receipt is available only after OSVIA verifies the payment.");
  const lines = [
    `Receipt number: RCT-${String(row.id).padStart(6, "0")}`,
    `Date verified: ${row.confirmed_at.slice(0, 10)}`,
    "",
    { heading: "Received from" },
    row.organization_name,
    "",
    { heading: "Payment" },
    `Amount: ${money(row.amount_ugx, row.currency)}`,
    `Method: ${row.method.replaceAll("_", " ")}`,
    `Reference: ${row.reference}`,
    row.invoice_number ? `Applied to invoice: ${row.invoice_number}` : "Not linked to an invoice",
    `Verified by: ${row.verifier}`,
  ];
  audit(db, actor.id, "payment.receipt", "payment", row.id, row.organization_id, null, actor.ip);
  sendFile(res, { body: buildPdf("Payment receipt", lines), type: "application/pdf", filename: `receipt-${row.id}.pdf` });
}

function summary({ db, actor, url }) {
  requireBillingAccess(actor);
  const organizationId = scopeOrgId(actor, url.searchParams.get("organizationId") || actor.organizationId);
  const org = mustOrg(db, organizationId);
  const totals = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(i.amount - (SELECT COALESCE(SUM(amount_ugx), 0) FROM payments WHERE invoice_id = i.id AND status = 'verified')), 0) FROM invoices i WHERE i.organization_id = ? AND i.status = 'issued') AS outstanding,
      (SELECT COUNT(*) FROM invoices WHERE organization_id = ? AND status = 'issued' AND due_date < ?) AS overdue,
      (SELECT COUNT(*) FROM payments WHERE organization_id = ? AND status = 'pending') AS pending
  `).get(organizationId, organizationId, todayUtc(), organizationId);
  return {
    planId: org.plan_id,
    planName: org.plan_name || "",
    price: org.price_ugx,
    subscriptionStatus: org.subscription_status,
    renewalDate: org.renewal_date,
    outstanding: totals.outstanding,
    overdueInvoices: totals.overdue,
    pendingPayments: totals.pending,
  };
}

export const routes = [
  ["GET", "/api/plans", listPlans],
  ["POST", "/api/plans", createPlan],
  ["PATCH", "/api/plans/:id", updatePlan],
  ["GET", "/api/billing/summary", summary],
  ["POST", "/api/billing/request-plan", requestPlan],
  ["POST", "/api/organizations/:id/subscription", changeSubscription],
  ["GET", "/api/organizations/:id/subscription-events", subscriptionHistory],
  ["GET", "/api/invoices", listInvoices],
  ["POST", "/api/invoices", createInvoice],
  ["GET", "/api/invoices/:id", ({ db, actor, params }) => ({ invoice: mapInvoice(loadInvoice(db, actor, params.id)) })],
  ["POST", "/api/invoices/:id/void", voidInvoice],
  ["GET", "/api/invoices/:id/pdf", invoicePdf],
  ["GET", "/api/payments", listPayments],
  ["POST", "/api/payments", recordPayment],
  ["POST", "/api/payments/:id/verify", verifyPayment],
  ["POST", "/api/payments/:id/reject", rejectPayment],
  ["GET", "/api/payments/:id/receipt", receiptPdf],
];
