import {
  api, badge, button, card, CATEGORIES, clear, confirmDialog, dataTable, definitionList, dialog, download, empty, enumOptions, errorBox, fmtDate,
  fmtDateTime, fmtRelative, formDialog, h, isRole, isStaff, label, money, orgOptions, pageHeader, PRIORITIES, skeleton, stat, state, toast,
} from "./core.js";
import { actionText, historyCard, withReason } from "./history.js";
import { subscriptionCard } from "./pages-billing.js";

export function organizationsPage(main, query) {
  const admin = isRole("admin");
  const table = dataTable({
    columns: [
      { label: "Organization", sort: "name", render: (o) => h("div", {}, h("strong", {}, o.name), h("small", { class: "muted block" }, `${o.contactName} · ${o.contactEmail}`)) },
      { label: "Status", sort: "status", render: (o) => badge(o.status) },
      { label: "Plan", render: (o) => o.planName || "—" },
      { label: "Subscription", render: (o) => badge(o.subscriptionStatus) },
      { label: "Renewal", sort: "renewal", render: (o) => fmtDate(o.renewalDate) },
      { label: "Joined", sort: "created", render: (o) => fmtDate(o.createdAt) },
    ],
    filters: [{ name: "status", label: "Status", value: query.get("status") || "", options: [["", "All"], ["pending", "Awaiting approval"], ["active", "Active"], ["suspended", "Suspended"]] }],
    defaultSort: { key: "created", dir: "desc" },
    searchPlaceholder: "Name, contact or email",
    load: (q) => api("GET", `/api/organizations?${q}`),
    rowHref: (o) => `#/organizations/${o.id}`,
    emptyText: "No organizations.",
  });
  clear(main, pageHeader("Organizations", "Customers supported by OSVIA.", admin ? [button("Add organization", () => formDialog("Add organization", [
    { name: "name", label: "Organization name", required: true, max: 160 },
    { name: "contactName", label: "Main contact", required: true, max: 120 },
    { name: "contactEmail", label: "Contact email", type: "email", required: true },
    { name: "contactPhone", label: "Phone", max: 40 },
    { name: "location", label: "Location", max: 160 },
    { type: "note", label: "The organization is created active. Invite its administrator from the organization page." },
  ], async (values, close) => {
    const r = await api("POST", "/api/organizations", values);
    close();
    location.hash = `#/organizations/${r.organization.id}`;
  }), { kind: "primary", iconName: "plus" })] : []), table.el);
}

function onboardingCard(onboarding) {
  return card("Onboarding checklist", h("ol", { class: "checklist" }, onboarding.steps.map((s) => h("li", { class: s.done ? "done" : "" }, h("span", { class: "tick", "aria-hidden": "true" }, s.done ? "✓" : ""), s.label, h("span", { class: "sr-only" }, s.done ? " (done)" : " (to do)")))), { cls: onboarding.complete ? "ok-card" : "" });
}

function usersCard(orgId, reload) {
  const canManage = isRole("admin", "customer_admin");
  const table = dataTable({
    columns: [
      { label: "Name", render: (u) => h("div", {}, h("strong", {}, u.name), h("small", { class: "muted block" }, u.email)) },
      { label: "Role", render: (u) => u.roleLabel },
      { label: "2FA", render: (u) => (u.mfaEnabled ? badge("ok", "On") : badge("muted", "Off")) },
      { label: "Last sign-in", render: (u) => (u.lastLoginAt ? fmtRelative(u.lastLoginAt) : "Never") },
      { label: "Status", render: (u) => (u.active ? badge("active") : badge("muted", "Disabled")) },
      canManage ? { label: "", render: (u) => (u.id === state.me.id ? h("small", { class: "muted" }, "You") : h("div", { class: "row-actions" },
        u.organizationId ? button(u.role === "customer_admin" ? "Make user" : "Make admin", () => withReason(`Change ${u.name}'s role`, u.role === "customer_admin" ? `${u.name} will become a normal user and lose administrator rights.` : `${u.name} will be able to manage users, billing and devices.`, async (reason) => {
          await api("PATCH", `/api/users/${u.id}`, { role: u.role === "customer_admin" ? "customer_user" : "customer_admin", reason });
          table.refresh();
        }, { submitLabel: "Change role" }), { kind: "small ghost" }) : null,
        button(u.active ? "Disable" : "Enable", () => withReason(u.active ? "Disable account" : "Enable account", u.active ? `${u.name} will be signed out and cannot sign in.` : `${u.name} will be able to sign in again.`, async (reason) => {
          await api("PATCH", `/api/users/${u.id}`, { active: !u.active, reason });
          table.refresh();
        }, { submitLabel: u.active ? "Disable" : "Enable" }), { kind: "small ghost" }),
        isRole("admin") && u.mfaEnabled ? button("Reset 2FA", () => withReason("Reset two-factor", `${u.name} must set up two-factor authentication again at next sign-in.`, async (reason) => {
          await api("POST", `/api/users/${u.id}/reset-mfa`, { reason });
          toast("Two-factor reset.");
          table.refresh();
        }, { submitLabel: "Reset", placeholder: "e.g. Lost phone, identity confirmed by phone call" }), { kind: "small ghost" }) : null)) } : null,
    ].filter(Boolean),
    searchPlaceholder: "Search people",
    load: (q) => api("GET", `/api/users?${q}${orgId && isStaff() ? `&organizationId=${orgId}` : !orgId ? "&role=staff" : ""}`),
    emptyText: "No users.",
  });
  return card("People", [table.el, canManage ? invitationsBlock(orgId, () => { table.refresh(); reload?.(); }) : null]);
}

function invitationsBlock(orgId, onChange) {
  const host = h("div", { class: "invites" });
  const load = async () => {
    const data = await api("GET", `/api/invitations${orgId && isStaff() ? `?organizationId=${orgId}` : ""}`);
    const pending = data.items.filter((i) => i.state === "pending" && (orgId ? i.organizationId === orgId : !i.organizationId));
    clear(host,
      h("div", { class: "row" }, h("h3", {}, "Invitations"), h("div", { class: "spacer" }), button("Invite someone", () => inviteDialog(orgId, load), { kind: "primary small", iconName: "plus" })),
      pending.length ? h("ul", { class: "mini-list" }, pending.map((i) => h("li", {}, h("span", { class: "grow" }, `${i.email} · ${label(i.role)}`), h("small", { class: "muted" }, `expires ${fmtRelative(i.expiresAt)}`), button("Revoke", async () => {
        await api("POST", `/api/invitations/${i.id}/revoke`);
        load();
      }, { kind: "small ghost" })))) : h("p", { class: "muted small" }, "No pending invitations."));
    onChange?.();
  };
  load().catch((e) => clear(host, errorBox(e, load)));
  return host;
}

function inviteDialog(orgId, onDone) {
  const roles = orgId ? [["customer_user", "User: opens and follows their own tickets"], ["customer_admin", "Administrator: manages users, devices and billing"]] : [["technician", "Technician"]];
  formDialog("Invite someone", [
    { name: "name", label: "Name", max: 120 },
    { name: "email", label: "Email", type: "email", required: true },
    { name: "role", label: "Role", type: "select", options: roles },
  ], async (values, close) => {
    const r = await api("POST", "/api/invitations", { ...values, organizationId: orgId || undefined });
    close();
    if (r.link) {
      const input = h("input", { value: r.link, readonly: true, class: "mono", "aria-label": "Invitation link" });
      dialog("Share this invitation link", [h("p", {}, "Email is not configured, so send this link to the person yourself. It works once and expires in 7 days."), input, button("Copy link", async () => {
        await navigator.clipboard.writeText(r.link);
        toast("Copied.");
      }, { kind: "primary" })]);
    } else toast("Invitation emailed.");
    onDone?.();
  });
}

export async function organizationDetailPage(main, id) {
  clear(main, skeleton(8));
  let data;
  try {
    data = await api("GET", `/api/organizations/${id}`);
  } catch (error) {
    clear(main, pageHeader("Organization"), errorBox(error, () => organizationDetailPage(main, id)));
    return;
  }
  const o = data.organization;
  const admin = isRole("admin");
  const reload = () => organizationDetailPage(main, id);
  const actions = [];
  if (admin && o.status === "pending") actions.push(button("Approve", async () => {
    await api("POST", `/api/organizations/${o.id}/approve`);
    toast("Approved. The customer was notified.");
    reload();
  }, { kind: "primary", iconName: "check" }));
  if (admin && o.status !== "suspended") actions.push(button("Suspend", () => formDialog(`Suspend ${o.name}`, [{ type: "note", label: "All users are signed out and cannot sign in until reactivated. Data is kept." }, { name: "reason", label: "Reason", required: true, max: 300 }], async (values, close) => {
    await api("POST", `/api/organizations/${o.id}/suspend`, values);
    close();
    toast("Suspended.");
    reload();
  }, { submitLabel: "Suspend" }), { kind: "ghost danger-text" }));
  if (admin && o.status === "suspended") actions.push(button("Reactivate", () => withReason(`Reactivate ${o.name}`, "Users can sign in again straight away.", async (reason) => {
    await api("POST", `/api/organizations/${o.id}/reactivate`, { reason });
    toast("Reactivated.");
    reload();
  }, { submitLabel: "Reactivate", placeholder: "e.g. Outstanding invoice paid and verified" }), { kind: "primary" }));
  if (admin || isRole("customer_admin")) actions.push(button("Edit", () => editOrgDialog(o, reload), { kind: "ghost" }));

  clear(main,
    isStaff() ? h("a", { href: "#/organizations", class: "back" }, "← Organizations") : null,
    pageHeader(o.name, `${o.location || "No location"} · since ${fmtDate(o.createdAt)}`, actions),
    o.status === "suspended" ? h("div", { class: "banner bad" }, h("strong", {}, "Suspended. "), o.suspensionReason) : null,
    h("div", { class: "stats" },
      stat("Status", label(o.status), { tone: o.status === "active" ? "ok" : o.status === "pending" ? "warn" : "bad" }),
      stat("Devices", `${data.counts.devices}${o.deviceLimit ? ` / ${o.deviceLimit}` : ""}`, { href: isStaff() ? `#/devices` : "#/devices" }),
      stat("Open tickets", data.counts.openTickets, { href: "#/tickets" }),
      stat("Active users", data.counts.users),
      stat("Monitors", `${data.counts.monitors}${o.monitorLimit ? ` / ${o.monitorLimit}` : ""}`)),
    h("div", { class: "grid-2" },
      card("Contact", definitionList([["Main contact", o.contactName], ["Email", o.contactEmail], ["Phone", o.contactPhone], ["Location", o.location], ["Time zone", o.timezone], isStaff() ? ["MeshCentral group", o.meshGroupId ? h("span", { class: "mono small" }, o.meshGroupId) : "Not mapped"] : null])),
      onboardingCard(data.onboarding)),
    isRole("admin", "customer_admin") ? subscriptionCard(o, reload) : null,
    isRole("admin", "customer_admin") ? subscriptionHistory(o.id) : null,
    isRole("admin", "customer_admin", "technician") ? usersCard(o.id, null) : null,
    isRole("admin", "customer_admin", "technician") ? historyCard("organization", o.id) : null);
}

function subscriptionHistory(orgId) {
  const host = h("div");
  api("GET", `/api/organizations/${orgId}/subscription-events`).then((r) => clear(host, r.items.length ? h("ul", { class: "mini-list" }, r.items.map((e) => h("li", {}, h("span", { class: "muted" }, fmtDateTime(e.createdAt)), h("span", { class: "grow" }, `${e.fromStatus ? `${label(e.fromStatus)} → ` : ""}${label(e.toStatus)}${e.planName ? ` · ${e.planName}` : ""}${e.note ? ` · ${e.note}` : ""}`), h("small", {}, e.actorName)))) : empty("No subscription changes yet"))).catch((e) => clear(host, errorBox(e)));
  return card("Subscription history", host, { cls: "subtle" });
}

function editOrgDialog(o, reload) {
  formDialog(`Edit ${o.name}`, [
    { name: "name", label: "Organization name", required: true, max: 160, value: o.name },
    { name: "contactName", label: "Main contact", required: true, max: 120, value: o.contactName },
    { name: "contactEmail", label: "Contact email", type: "email", required: true, value: o.contactEmail },
    { name: "contactPhone", label: "Phone", max: 40, value: o.contactPhone },
    { name: "location", label: "Location", max: 160, value: o.location },
    { name: "timezone", label: "Time zone", max: 60, value: o.timezone },
    isRole("admin") ? { name: "meshGroupId", label: "MeshCentral device group id", max: 200, value: o.meshGroupId, help: "For example mesh//abc123. Devices in this group sync into this organization." } : null,
  ].filter(Boolean), async (values, close) => {
    await api("PATCH", `/api/organizations/${o.id}`, values);
    close();
    toast("Saved.");
    reload();
  }, { wide: true });
}

export function myOrganizationPage(main) {
  return organizationDetailPage(main, state.me.organizationId);
}

export function teamPage(main) {
  clear(main, pageHeader("OSVIA team", "Administrators and technicians. Every staff account must use two-factor authentication."), usersCard(null, null));
}

export async function reportsPage(main, query) {
  const staff = isStaff();
  const today = new Date().toISOString().slice(0, 10);
  const from = h("input", { type: "date", value: query.get("from") || `${today.slice(0, 7)}-01`, "aria-label": "From" });
  const to = h("input", { type: "date", value: query.get("to") || today, "aria-label": "To" });
  const org = staff ? h("select", { "aria-label": "Organization" }, (await orgOptions(true).catch(() => [["", "All organizations"]])).map(([v, t]) => h("option", { value: v }, t))) : null;
  const body = h("div");
  const params = () => new URLSearchParams(Object.entries({ from: from.value, to: to.value, organizationId: org?.value || "" }).filter(([, v]) => v));
  const load = async () => {
    clear(body, skeleton(6));
    try {
      const r = await api("GET", `/api/reports/summary?${params()}`);
      const pct = (v) => (v === null ? "No data" : `${v}%`);
      clear(body,
        h("p", { class: "muted" }, `${r.organization} · ${fmtDate(r.period.from)} to ${fmtDate(r.period.to)}`),
        h("div", { class: "stats" },
          stat("Tickets opened", r.tickets.created), stat("Resolved", r.tickets.resolved), stat("Open now", r.tickets.openNow),
          stat("First response on time", pct(r.tickets.responseSlaPercent), { tone: r.tickets.responseSlaPercent !== null && r.tickets.responseSlaPercent < 90 ? "warn" : "" }),
          stat("Resolved on time", pct(r.tickets.resolutionSlaPercent)),
          stat("Average first response", r.tickets.avgFirstResponseMinutes !== null ? `${r.tickets.avgFirstResponseMinutes} min` : "No data"),
          stat("Average resolution", r.tickets.avgResolutionHours !== null ? `${r.tickets.avgResolutionHours} h` : "No data"),
          stat("Monitored uptime", pct(r.monitoring.uptimePercent), { hint: `${r.monitoring.checks} checks` }),
          stat("Incidents", r.incidents.total, { hint: `${r.incidents.downtimeMinutes} min downtime` }),
          stat("Maintenance done", r.maintenance.completed, { hint: `${r.maintenance.overdue} overdue now` }),
          stat("Devices online now", `${r.devices.online} / ${r.devices.total}`, { hint: `${r.devices.unknown} not checked` }),
          r.billing ? stat("Verified payments", money(r.billing.collected), { hint: `Invoiced ${money(r.billing.invoiced)}` }) : null),
        h("div", { class: "grid-2" },
          card("Tickets by category", bars(r.tickets.byCategory)),
          card("Tickets by priority", bars(r.tickets.byPriority))),
        r.technicians ? card("Technician workload", h("div", { class: "table-scroll" }, h("table", { class: "table" }, h("thead", {}, h("tr", {}, h("th", {}, "Technician"), h("th", {}, "Resolved"), h("th", {}, "Open"), h("th", {}, "Time logged"))), h("tbody", {}, r.technicians.map((t) => h("tr", {}, h("td", {}, t.name), h("td", {}, t.resolved), h("td", {}, t.open), h("td", {}, `${Math.round(t.minutes / 6) / 10} h`))))))) : null);
    } catch (error) {
      clear(body, errorBox(error, load));
    }
  };
  clear(main, pageHeader("Reports", "Figures are calculated from recorded tickets, checks and payments for the period.", [
    button("PDF", () => download(`/api/reports/summary.pdf?${params()}`), { kind: "ghost", iconName: "download" }),
    button("Tickets CSV", () => download(`/api/reports/tickets.csv?${params()}`), { kind: "ghost", iconName: "download" }),
  ]), h("div", { class: "filters" }, h("label", {}, "From ", from), h("label", {}, "To ", to), org, button("Apply", load, { kind: "primary" })), body);
  load();
}

function bars(rows) {
  if (!rows.length) return empty("No tickets in this period");
  const max = Math.max(...rows.map((r) => r.n));
  return h("ul", { class: "bars" }, rows.map((r) => {
    const fill = h("span", { class: "bar-fill" });
    fill.style.width = `${Math.max(4, (r.n / max) * 100)}%`;
    return h("li", {}, h("span", { class: "bar-label" }, label(r.key)), h("span", { class: "bar" }, fill), h("span", { class: "bar-value" }, r.n));
  }));
}

const RECORD_LINKS = { ticket: "tickets", device: "devices", organization: "organizations", monitor: "monitoring", incident: "incidents" };

function recordLink(a) {
  const text = `${label(a.entityType)}${a.entityId ? ` #${a.entityId}` : ""}`;
  const base = RECORD_LINKS[a.entityType];
  if (!base || !a.entityId) return text;
  if (base === "organizations" && !isStaff()) return h("a", { href: "#/organization" }, text);
  return h("a", { href: `#/${base}/${a.entityId}` }, text);
}

export function auditPage(main) {
  const actor = h("input", { type: "search", placeholder: "Person", "aria-label": "Person" });
  const words = h("input", { type: "search", placeholder: "Reason or detail", "aria-label": "Reason or detail" });
  const apply = () => {
    table.params.actor = actor.value;
    table.params.q = words.value;
    table.params.page = 1;
    return table.refresh();
  };
  for (const input of [actor, words]) input.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
  const table = dataTable({
    columns: [
      { label: "When", render: (a) => h("div", {}, fmtDateTime(a.createdAt), h("small", { class: "muted block" }, fmtRelative(a.createdAt))) },
      { label: "Who", render: (a) => h("div", {}, a.actorName, h("small", { class: "muted block" }, a.actorEmail || label(a.actorRole || "system"))) },
      { label: "What", render: (a) => h("div", { class: "audit-what" },
        h("span", {}, actionText(a.action)),
        a.changes.length ? h("ul", { class: "change-list compact" }, a.changes.slice(0, 4).map((c) => h("li", {}, h("span", { class: "change-field" }, label(c.field)), h("span", { class: "change-from" }, c.from ?? "empty"), h("span", { class: "change-arrow" }, "→"), h("span", { class: "change-to" }, c.to ?? "empty")))) : null) },
      { label: "Why", render: (a) => (a.reason ? h("span", { class: "reason-text" }, a.reason) : h("span", { class: "muted" }, "—")) },
      { label: "Record", render: (a) => h("div", {}, recordLink(a), a.organizationName && isStaff() ? h("small", { class: "muted block" }, a.organizationName) : null) },
      isRole("admin") ? { label: "IP", render: (a) => h("span", { class: "mono small" }, a.ip || "—") } : null,
    ].filter(Boolean),
    searchPlaceholder: null,
    toolbar: [actor, words, button("Filter", apply, { kind: "ghost small" }), button("Export CSV", () => download(`/api/audit/export.csv?${new URLSearchParams(Object.entries(table.params).filter(([, v]) => v))}`), { kind: "ghost small", iconName: "download" })],
    filters: [{ name: "action", label: "Action", value: "", options: [["", "All actions"], ["login", "Sign-ins"], ["ticket", "Tickets"], ["payment", "Payments"], ["invoice", "Invoices"], ["subscription", "Subscriptions"], ["remote", "Remote sessions"], ["device", "Devices"], ["monitor", "Monitors"], ["incident", "Incidents"], ["organization", "Organizations"], ["user", "Users"], ["invitation", "Invitations"], ["settings", "Settings"], ["kb", "Help articles"]] }],
    load: (q) => api("GET", `/api/audit?${q}`),
    emptyText: "No audit events.",
  });
  clear(main, pageHeader("Audit log", "Every change: who made it, what changed from and to, and the reason they gave. Entries cannot be edited or deleted."), table.el);
}

export async function settingsPage(main, query) {
  const tab = query.get("tab") || "general";
  const tabs = h("nav", { class: "tabs" }, [["general", "General"], ["sla", "SLA policies"], ["holidays", "Holidays"], ["system", "System health"], ["backups", "Backups"]].map(([key, text]) => h("a", { href: `#/settings${key === "general" ? "" : `?tab=${key}`}`, class: tab === key ? "active" : "" }, text)));
  const body = h("div");
  clear(main, pageHeader("Settings"), tabs, body);
  const tabFns = { general: generalSettings, sla: slaSettings, holidays: holidaySettings, system: systemSettings, backups: backupSettings };
  await (tabFns[tab] || generalSettings)(body);
}

async function generalSettings(body) {
  clear(body, skeleton(3));
  try {
    const { settings } = await api("GET", "/api/settings");
    const fields = [
      ["support_email", "Support email", "email"], ["support_phone", "Support phone", "text"], ["invoice_prefix", "Invoice number prefix", "text"],
      ["invoice_due_days", "Invoice due after (days)", "number"], ["reopen_days", "Customers may reopen for (days)", "number"], ["auto_close_days", "Auto-close resolved tickets after (days)", "number"],
    ];
    const inputs = {};
    const form = h("form", { class: "form" }, fields.map(([key, text, type]) => {
      inputs[key] = h("input", { type, value: settings[key] ?? "", id: `s-${key}` });
      return h("div", { class: "field" }, h("label", { for: `s-${key}` }, text), inputs[key]);
    }));
    inputs.escalation_text = h("textarea", { rows: 3, id: "s-esc" });
    inputs.escalation_text.value = settings.escalation_text || "";
    form.append(h("div", { class: "field full" }, h("label", { for: "s-esc" }, "Escalation guidance shown to customers"), inputs.escalation_text));
    clear(body, card("General", [form, button("Save settings", async () => {
      const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === "number" ? Number(el.value) : el.value]));
      await api("PATCH", "/api/settings", values);
      toast("Settings saved.");
    }, { kind: "primary" })]), h("p", { class: "muted small" }, `Default currency ${settings.default_currency || "UGX"}, time zone ${settings.default_timezone || "Africa/Kampala"}. Email (SMTP) and MeshCentral are configured in the server's .env file, not here, so their secrets never reach the browser.`));
  } catch (error) {
    clear(body, errorBox(error, () => generalSettings(body)));
  }
}

async function slaSettings(body) {
  const [policies, plans] = await Promise.all([api("GET", "/api/sla-policies"), api("GET", "/api/plans")]);
  const edit = (p) => formDialog(p ? `Edit ${p.name}` : "New SLA policy", [
    { name: "name", label: "Name", required: true, max: 120, value: p?.name },
    { name: "planId", label: "Plan", type: "select", options: [["", "No plan (fallback)"], ...plans.items.map((x) => [String(x.id), x.name])], value: p?.planId ? String(p.planId) : "" },
    { name: "priority", label: "Priority", type: "select", options: enumOptions(PRIORITIES), value: p?.priority || "normal" },
    { name: "category", label: "Category", type: "select", options: enumOptions(CATEGORIES, "Any category"), value: p?.category || "" },
    { name: "responseMinutes", label: "First response target (minutes)", type: "number", required: true, min: 1, value: p?.responseMinutes },
    { name: "resolutionMinutes", label: "Resolution target (minutes)", type: "number", min: 1, value: p?.resolutionMinutes ?? "", help: "Leave empty when the plan has no resolution commitment." },
    { name: "businessHoursOnly", label: "Count business hours only", type: "checkbox", value: p ? p.businessHoursOnly : true },
    { name: "businessStart", label: "Business day starts", type: "time", value: p?.businessStart || "08:00" },
    { name: "businessEnd", label: "Business day ends", type: "time", value: p?.businessEnd || "17:00" },
    { name: "businessDays", label: "Business days", value: p?.businessDays || "1,2,3,4,5", help: "1 = Monday … 7 = Sunday, comma separated." },
    { name: "timezone", label: "Time zone", value: p?.timezone || "Africa/Kampala" },
    { name: "excludeHolidays", label: "Skip public holidays", type: "checkbox", value: p ? p.excludeHolidays : true },
    { name: "escalateAtPercent", label: "Escalate at (% of target)", type: "number", min: 1, maxValue: 100, value: p?.escalateAtPercent ?? 75 },
    p ? { name: "active", label: "Active", type: "checkbox", value: p.active } : null,
  ].filter(Boolean), async (values, close) => {
    const payload = { ...values, planId: values.planId ? Number(values.planId) : null, category: values.category || null, resolutionMinutes: values.resolutionMinutes || null };
    if (p) await api("PATCH", `/api/sla-policies/${p.id}`, payload);
    else await api("POST", "/api/sla-policies", payload);
    close();
    toast("Policy saved. It applies to new tickets.");
    slaSettings(body);
  }, { wide: true });
  const hours = (m) => (m === null ? "—" : m >= 60 ? `${Math.round((m / 60) * 10) / 10} h` : `${m} min`);
  clear(body, card("SLA policies", [
    h("p", { class: "muted small" }, "The most specific active policy for the organization's active plan and the ticket priority (and category, if set) applies. Organizations without an active plan use the No plan policies."),
    h("div", { class: "table-scroll" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, ["Policy", "Plan", "Priority", "Category", "First response", "Resolution", "Hours", "Escalate", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, policies.items.map((p) => h("tr", { class: p.active ? "" : "muted" }, h("td", {}, p.name), h("td", {}, p.planName), h("td", {}, badge(p.priority)), h("td", {}, p.category ? label(p.category) : "Any"), h("td", {}, hours(p.responseMinutes)), h("td", {}, hours(p.resolutionMinutes)), h("td", {}, p.businessHoursOnly ? `${p.businessStart}–${p.businessEnd}` : "24/7"), h("td", {}, `${p.escalateAtPercent}%`), h("td", {}, button("Edit", () => edit(p), { kind: "small ghost" }))))))),
  ], { actions: button("New policy", () => edit(null), { kind: "primary small", iconName: "plus" }) }));
}

async function holidaySettings(body) {
  const data = await api("GET", "/api/holidays");
  clear(body, card("Public holidays", [
    h("p", { class: "muted small" }, "Business-hours SLA clocks do not run on these dates. Movable holidays (Eid, Easter) change every year; add them when announced."),
    h("ul", { class: "mini-list" }, data.items.map((d) => h("li", {}, h("span", { class: "mono" }, d.date), h("span", { class: "grow" }, d.name), button("Remove", async () => {
      await api("DELETE", `/api/holidays/${d.id}`);
      holidaySettings(body);
    }, { kind: "small ghost" })))),
  ], { actions: button("Add holiday", () => formDialog("Add holiday", [{ name: "date", label: "Date", type: "date", required: true }, { name: "name", label: "Name", required: true, max: 120 }], async (values, close) => {
    await api("POST", "/api/holidays", values);
    close();
    holidaySettings(body);
  }), { kind: "primary small", iconName: "plus" }) }));
}

async function systemSettings(body) {
  clear(body, skeleton(4));
  const s = await api("GET", "/api/system");
  const names = { meshcentral: "MeshCentral", smtp: "Email (SMTP)", monitor_runner: "Monitoring checks", scheduler: "Background jobs", backup: "Backups" };
  clear(body,
    card("Integrations", h("ul", { class: "health-list" }, Object.entries(s.health).map(([name, item]) => h("li", {}, h("div", {}, h("strong", {}, names[name] || label(name)), h("small", { class: "muted" }, item.detail || "")), h("div", { class: "right" }, badge(item.status), item.checkedAt ? h("small", { class: "muted" }, fmtRelative(item.checkedAt)) : null)))), {
      actions: [
        button("Check MeshCentral", async () => {
          const r = await api("POST", "/api/integrations/meshcentral/check");
          toast(`MeshCentral: ${label(r.status)}${r.detail ? ` · ${r.detail}` : ""}`, r.status === "ok" ? "ok" : "error");
          systemSettings(body);
        }, { kind: "ghost small" }),
      ],
    }),
    card("Security", [
      definitionList([
        ["Database schema", `Version ${s.schemaVersion}`],
        ["Extra sign-in check", s.staffMfaRequired ? "On — authenticator code after email and password" : "Off — email and password only"],
        ["Backups encrypted", s.backupEncrypted ? "Yes" : "No: set BACKUP_KEY"],
        ["Email", s.smtpConfigured ? "Configured" : "Not configured: emails are recorded as skipped"],
        ["MeshCentral", s.meshConfigured ? "Configured" : "Not configured"],
      ]),
      isRole("admin") ? h("p", { class: "muted small" }, s.staffMfaRequired
        ? "Turn this off if you need to sign in with email and password only. Turn it on again when you want the extra check."
        : "Turn this on when you want staff sign-in to ask for an authenticator code.") : null,
      isRole("admin") ? button(s.staffMfaRequired ? "Turn off extra sign-in check" : "Require authenticator at sign-in", async () => {
        await api("PATCH", "/api/settings", { staff_mfa_required: s.staffMfaRequired ? "0" : "1" });
        toast(s.staffMfaRequired ? "Extra sign-in check is off. Email and password are enough." : "Extra sign-in check is on. Staff must use an authenticator code.");
        systemSettings(body);
      }, { kind: s.staffMfaRequired ? "ghost" : "primary" }) : null,
    ]),
    card("Email queue", [definitionList(Object.entries(s.outbox).map(([k, v]) => [label(k), v])), s.recentEmailErrors.length ? h("div", { class: "table-scroll" }, h("table", { class: "table" }, h("thead", {}, h("tr", {}, ["When", "To", "Subject", "Attempts", "Error"].map((t) => h("th", {}, t)))), h("tbody", {}, s.recentEmailErrors.map((e) => h("tr", {}, h("td", {}, fmtDateTime(e.created_at)), h("td", {}, e.to_email), h("td", {}, e.subject), h("td", {}, e.attempts), h("td", {}, e.last_error)))))) : null]));
}

async function backupSettings(body) {
  const data = await api("GET", "/api/admin/backups");
  clear(body, card("Backups", [
    data.encryptionConfigured ? null : h("div", { class: "banner warn" }, "BACKUP_KEY is not set, so backups are not encrypted. Set it in .env and keep a copy of the key somewhere safe."),
    h("p", { class: "muted small" }, `A backup runs every night and the newest ${14} are kept in ${data.directory}. Backups stay on the server; copy them to another disk or machine. Restore with npm run restore while the portal is stopped.`),
    data.items.length ? h("ul", { class: "mini-list" }, data.items.map((b) => h("li", {}, h("span", { class: "mono small grow" }, b.name), h("small", { class: "muted" }, `${Math.round(b.size / 1024)} KB · ${fmtDateTime(b.createdAt)}`), b.encrypted ? badge("ok", "Encrypted") : badge("pending", "Plain")))) : empty("No backups yet"),
  ], { actions: button("Back up now", async () => {
    const r = await api("POST", "/api/admin/backups");
    toast(r.message);
    backupSettings(body);
  }, { kind: "primary small" }) }));
}

export async function accountPage(main) {
  clear(main, pageHeader("Account"), skeleton(4));
  const [me, sessions] = await Promise.all([api("GET", "/api/me"), api("GET", "/api/me/sessions")]);
  const u = me.user;
  const reload = () => accountPage(main);
  const mfaBlock = u.mfaEnabled
    ? [h("p", {}, badge("ok", "On"), " Your sign-in requires a code from your authenticator app."),
      isStaff() && me.staffMfaRequired ? h("p", { class: "muted small" }, "Staff accounts must keep two-factor authentication on while the extra sign-in check is required in Settings.") : button("Turn off", () => formDialog("Turn off two-factor", [{ name: "code", label: "Current code", required: true, inputmode: "numeric" }], async (values, close) => {
        await api("POST", "/api/me/mfa/disable", values);
        close();
        reload();
      }), { kind: "ghost" })]
    : [me.mustEnrollMfa ? h("div", { class: "banner warn" }, "Staff tools stay locked until you turn on two-factor authentication.") : h("p", { class: "muted" }, "Add a second step to your sign-in with an authenticator app such as Google Authenticator or Microsoft Authenticator."),
      button("Set up two-factor", async () => {
        const start = await api("POST", "/api/me/mfa/start");
        formDialog("Set up two-factor authentication", [
          { type: "note", label: "In your authenticator app, add an account with this setup key (time-based), then enter the 6-digit code it shows." },
          { type: "note", label: start.secret.replace(/(.{4})/g, "$1 ").trim() },
          { name: "code", label: "6-digit code", required: true, inputmode: "numeric", autocomplete: "one-time-code" },
        ], async (values, close) => {
          await api("POST", "/api/me/mfa/confirm", values);
          close();
          toast("Two-factor authentication is on.");
          location.reload();
        }, { submitLabel: "Turn on" });
      }, { kind: "primary" })];
  clear(main, pageHeader("Account", `${u.roleLabel}${state.org ? ` · ${state.org.name}` : ""}`),
    h("div", { class: "grid-2" },
      card("Profile", [definitionList([["Email", u.email], ["Role", u.roleLabel], ["Last sign-in", fmtDateTime(u.lastLoginAt)]]), button("Edit profile", () => formDialog("Edit profile", [
        { name: "name", label: "Name", required: true, max: 120, value: u.name },
        { name: "phone", label: "Phone", max: 40, value: u.phone },
        { name: "emailNotifications", label: "Email me about my tickets, incidents and billing", type: "checkbox", value: u.emailNotifications },
      ], async (values, close) => {
        await api("PATCH", "/api/me", values);
        close();
        toast("Saved.");
        reload();
      }), { kind: "ghost" })]),
      card("Two-factor authentication", mfaBlock)),
    h("div", { class: "grid-2" },
      card("Password", button("Change password", () => formDialog("Change password", [
        { name: "currentPassword", label: "Current password", type: "password", required: true, autocomplete: "current-password" },
        { name: "newPassword", label: "New password", type: "password", required: true, autocomplete: "new-password", help: "At least 10 characters. Other sessions will be signed out." },
      ], async (values, close) => {
        await api("POST", "/api/me/password", values);
        close();
        toast("Password changed.");
      }), { kind: "ghost" })),
      card("Signed-in sessions", [h("ul", { class: "mini-list" }, sessions.items.map((s) => h("li", {}, h("span", { class: "grow" }, s.userAgent.slice(0, 60) || "Unknown browser", h("small", { class: "muted block" }, `${s.ip} · last active ${fmtRelative(s.lastSeenAt)}`)), s.current ? badge("ok", "This browser") : null))),
        sessions.items.length > 1 ? button("Sign out other sessions", async () => {
          const r = await api("POST", "/api/me/sessions/revoke-others");
          toast(`${r.revoked} session(s) signed out.`);
          reload();
        }, { kind: "ghost" }) : null])));
}

export function notificationsPage(main) {
  const table = dataTable({
    columns: [
      { label: "", render: (n) => (n.readAt ? "" : h("span", { class: "dot", title: "Unread" })) },
      { label: "Notification", render: (n) => h("div", {}, h("strong", {}, n.title), h("small", { class: "muted block" }, n.body)) },
      { label: "Type", render: (n) => label(n.kind) },
      { label: "When", render: (n) => fmtRelative(n.createdAt) },
    ],
    filters: [{ name: "unread", label: "Show", value: "", options: [["", "All"], ["1", "Unread"]] }],
    searchPlaceholder: null,
    toolbar: [button("Mark all read", async () => {
      await api("POST", "/api/notifications/read-all");
      state.unread = 0;
      document.dispatchEvent(new CustomEvent("osvia:unread"));
      table.refresh();
    }, { kind: "ghost small" })],
    load: (q) => api("GET", `/api/notifications?${q}`),
    rowHref: (n) => {
      if (!n.readAt) api("POST", `/api/notifications/${n.id}/read`).then(() => document.dispatchEvent(new CustomEvent("osvia:unread"))).catch(() => {});
      return n.link ? `#/${n.link}` : "#/notifications";
    },
    emptyText: "No notifications.",
  });
  clear(main, pageHeader("Notifications"), table.el);
}
