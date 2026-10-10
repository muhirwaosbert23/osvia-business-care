import { api, card, clear, empty, errorBox, fmtDateTime, fmtRelative, formDialog, h, label, skeleton } from "./core.js";

// Opens a dialog that requires a written reason, then runs action(reason). The reason is stored in the record's history.
export function withReason(title, message, action, { submitLabel = "Confirm", placeholder = "" } = {}) {
  formDialog(title, [
    message ? { type: "note", label: message } : null,
    { name: "reason", label: "Reason (kept in the history)", type: "textarea", rows: 2, required: true, max: 300, full: true, placeholder },
  ].filter(Boolean), async (values, close) => {
    await action(values.reason);
    close();
  }, { submitLabel });
}

export const ACTIONS = {
  "admin.setup": "created the administrator account",
  "login.succeeded": "signed in",
  "login.failed": "had a failed sign-in",
  "login.mfa_failed": "entered a wrong two-factor code",
  "login.blocked_suspended": "was blocked from signing in (suspended)",
  logout: "signed out",
  "password.change": "changed their password",
  "password.reset_request": "asked for a password reset",
  "password.reset": "reset their password by email",
  "mfa.enable": "turned on two-factor authentication",
  "mfa.disable": "turned off two-factor authentication",
  "sessions.revoke": "signed out other sessions",
  "user.update": "updated a user",
  "user.mfa_reset": "reset a user's two-factor",
  "invitation.create": "sent an invitation",
  "invitation.accept": "accepted an invitation",
  "invitation.revoke": "revoked an invitation",
  "organization.create": "added an organization",
  "organization.register": "registered an organization",
  "organization.update": "updated an organization",
  "organization.approve": "approved an organization",
  "organization.suspend": "suspended an organization",
  "organization.reactivate": "reactivated an organization",
  "ticket.create": "opened a ticket",
  "ticket.update": "updated a ticket",
  "ticket.reply": "replied on a ticket",
  "ticket.note": "added an internal note",
  "ticket.work_log": "logged work time",
  "ticket.reopen": "reopened a ticket",
  "ticket.close": "closed a ticket",
  "ticket.csat": "rated the support received",
  "attachment.upload": "attached a file",
  "attachment.download": "downloaded an attachment",
  "device.create": "added a device",
  "device.update": "updated a device",
  "device.restore": "restored a device",
  "device.archive": "archived a device",
  "device.export": "exported the device list",
  "device.consent": "gave remote-support consent",
  "device.consent_revoke": "revoked remote-support consent",
  "device.locate": "placed a device on the map",
  "device.diagnose": "ran a remote diagnostic",
  "device.finding": "recorded a troubleshooting note",
  "remote.launch": "started a remote session",
  "maintenance.record": "recorded maintenance",
  "maintenance.report": "downloaded a maintenance report",
  "maintenance_schedule.create": "scheduled maintenance",
  "maintenance_schedule.update": "updated a maintenance schedule",
  "maintenance_schedule.complete": "completed scheduled maintenance",
  "maintenance_window.create": "planned a maintenance window",
  "maintenance_window.end": "ended a maintenance window",
  "monitor.create": "added a monitor",
  "monitor.update": "updated a monitor",
  "monitor.pause": "paused a monitor",
  "monitor.delete": "deleted a monitor",
  "incident.create": "opened an incident",
  "incident.update": "updated an incident",
  "incident.resolve": "resolved an incident",
  "plan.create": "created a service plan",
  "plan.update": "updated a service plan",
  "subscription.request": "requested a plan",
  "subscription.update": "changed a subscription",
  "invoice.create": "issued an invoice",
  "invoice.void": "voided an invoice",
  "invoice.paid": "marked an invoice paid after verification",
  "invoice.pdf": "downloaded an invoice",
  "payment.record": "recorded a payment",
  "payment.verify": "verified a payment",
  "payment.reject": "rejected a payment",
  "payment.receipt": "downloaded a receipt",
  "report.pdf": "downloaded a report",
  "report.csv": "exported report data",
  "sla_policy.create": "created an SLA policy",
  "sla_policy.update": "updated an SLA policy",
  "holiday.create": "added a holiday",
  "holiday.delete": "removed a holiday",
  "settings.update": "changed settings",
  "backup.create": "created a backup",
  "meshcentral.check": "checked MeshCentral",
  "meshcentral.sync": "synchronized MeshCentral devices",
  "kb.create": "wrote a help article",
  "kb.update": "edited a help article",
  "kb.delete": "deleted a help article",
};

export function actionText(action) {
  return ACTIONS[action] || action.replace(/[._]/g, " ");
}

const FIELD_LABELS = {
  assigned_to: "Assigned to",
  assigned_user_id: "Assigned user",
  device_id: "Device",
  plan_id: "Plan",
  subscription_status: "Subscription",
  check_port: "Check port",
  customer_visible: "Visible to customer",
  price_ugx: "Price (UGX)",
  response_due_at: "Reply due",
  resolution_due_at: "Resolution due",
  mesh_group_id: "MeshCentral group",
};

const BOOLEAN_FIELDS = new Set(["active", "customer_visible", "published"]);

function fieldValue(field, value) {
  if (value === null || value === undefined || value === "") return h("em", { class: "muted" }, "empty");
  if (BOOLEAN_FIELDS.has(field)) return Number(value) ? "Yes" : "No";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return fmtDateTime(value);
  if (["status", "priority", "category", "impact", "role", "condition", "operational_status", "asset_type", "subscription_status", "severity"].includes(field)) return label(value);
  return String(value);
}

function changeList(changes) {
  if (!changes.length) return null;
  return h("ul", { class: "change-list" }, changes.map((c) => h("li", {},
    h("span", { class: "change-field" }, FIELD_LABELS[c.field] || label(c.field)),
    h("span", { class: "change-from" }, fieldValue(c.field, c.from)),
    h("span", { class: "change-arrow", "aria-label": "changed to" }, "→"),
    h("span", { class: "change-to" }, fieldValue(c.field, c.to)))));
}

function tone(action) {
  if (/failed|blocked|reject|suspend|void|archive|delete|revoke|mfa_reset/.test(action)) return "bad";
  if (/verify|resolve|approve|paid|reactivate|restore|complete|consent$/.test(action)) return "ok";
  if (/remote\.launch/.test(action)) return "warn";
  return "";
}

export function timeline(items, { showRecord = false } = {}) {
  if (!items.length) return empty("No history yet", "Changes to this record will appear here with who made them and why.");
  return h("ol", { class: "hist-list" }, items.map((e) => h("li", { class: `hist-item ${tone(e.action)}` },
    h("span", { class: "hist-dot", "aria-hidden": "true" }),
    h("div", { class: "hist-body" },
      h("div", { class: "hist-head" },
        h("span", {}, h("strong", {}, e.actorName), e.actorRole ? h("span", { class: "muted small" }, ` (${label(e.actorRole)})`) : null, " ", actionText(e.action),
          showRecord && e.entityType ? h("span", { class: "muted" }, ` · ${label(e.entityType)}${e.entityId ? ` #${e.entityId}` : ""}`) : null),
        h("time", { class: "muted small", datetime: e.at, title: fmtDateTime(e.at) }, fmtRelative(e.at))),
      e.reason ? h("p", { class: "hist-reason" }, h("span", { class: "reason-label" }, "Why: "), e.reason) : null,
      changeList(e.changes),
      e.ip ? h("small", { class: "muted mono" }, `IP ${e.ip}`) : null))));
}

export function historyCard(type, id, { title = "History" } = {}) {
  const body = h("div", {}, skeleton(3));
  const load = () => api("GET", `/api/history?type=${type}&id=${id}`)
    .then((r) => clear(body, timeline(r.items)))
    .catch((error) => clear(body, errorBox(error, load)));
  load();
  return card(title, body, { cls: "history-card" });
}
