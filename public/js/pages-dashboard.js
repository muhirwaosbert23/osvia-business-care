import { api, badge, button, card, clear, empty, fmtRelative, h, icon, label, money, state, toast } from "./core.js";

const STATUS_ORDER = ["new", "open", "in_progress", "pending_customer"];
const PRIORITY_ORDER = ["urgent", "high", "normal", "low"];
const HEALTH_NAMES = { meshcentral: "MeshCentral", smtp: "Email (SMTP)", monitor_runner: "Monitoring checks", scheduler: "Background jobs", backup: "Backups" };

function greeting() {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Africa/Kampala" }).format(new Date()));
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

function todayLine() {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Kampala" }).format(new Date());
}

function kpi(title, value, { iconName, tone = "", hint = "", href = null, meter = null }) {
  const inner = [
    h("div", { class: "kpi-top" }, h("span", { class: `kpi-icon ${tone}` }, icon(iconName)), h("span", { class: "kpi-label" }, title)),
    h("div", { class: "kpi-value" }, value),
    meter !== null ? meterBar(meter, tone) : null,
    hint ? h("div", { class: "kpi-hint" }, hint) : null,
  ];
  return href ? h("a", { class: "kpi", href }, inner) : h("div", { class: "kpi" }, inner);
}

function meterBar(fraction, tone) {
  const fill = h("span", { class: `meter-fill ${tone}` });
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  return h("div", { class: "meter", role: "img", "aria-label": `${Math.round(fraction * 100)}%` }, fill);
}

function attentionItems(d, admin) {
  const items = [
    [d.tickets.breached, "SLA breached", "bad", "#/tickets?breached=1", "alert"],
    [d.tickets.urgent, "Urgent tickets open", "bad", "#/tickets?priority=urgent", "alert"],
    [d.tickets.unassigned, "Unassigned tickets", "warn", "#/tickets?assigned=none", "ticket"],
    [d.tickets.dueSoon, "Replies due within 2 hours", "warn", "#/tickets", "clock"],
    [d.monitors.down, "Monitors down", "bad", "#/monitoring", "pulse"],
    [d.monitors.stale, "Monitors without fresh results", "warn", "#/monitoring", "pulse"],
    [d.incidentsOpen, "Open incidents", "bad", "#/incidents", "alert"],
    [d.maintenanceOverdue, "Maintenance overdue", "warn", "#/maintenance", "wrench"],
  ];
  if (admin) {
    items.push(
      [d.organizationsPending, "Organizations awaiting approval", "warn", "#/organizations?status=pending", "building"],
      [d.paymentsPending, "Payments to verify", "warn", "#/billing", "money"],
      [d.invoicesOverdue, "Overdue invoices", "bad", "#/billing?tab=invoices", "money"],
      [d.emailFailed, "Emails failed to send", "bad", "#/settings?tab=system", "alert"],
    );
  }
  for (const [name, item] of Object.entries(d.health)) {
    if (item.status === "error" || item.status === "stale") items.push([1, `${HEALTH_NAMES[name] || label(name)}: ${label(item.status)}`, item.status === "error" ? "bad" : "warn", "#/settings?tab=system", "settings"]);
  }
  return items.filter(([count]) => count > 0);
}

function attentionCard(d, admin) {
  const items = attentionItems(d, admin);
  if (!items.length) {
    return h("section", { class: "attention clear-state" }, h("span", { class: "kpi-icon ok" }, icon("check")), h("div", {}, h("strong", {}, "All clear"), h("p", { class: "muted small" }, "No breached tickets, failing monitors or items waiting for you.")));
  }
  return h("section", { class: "attention", "aria-label": "Needs attention" },
    h("h2", {}, "Needs attention"),
    h("div", { class: "attention-list" }, items.map(([count, text, tone, href, iconName]) => h("a", { class: `attention-item ${tone}`, href },
      icon(iconName), h("span", { class: "attention-count" }, count), h("span", {}, text)))));
}

function trendChart(trend) {
  const max = Math.max(1, ...trend.map((t) => Math.max(t.opened, t.resolved)));
  const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const totals = trend.reduce((acc, t) => ({ opened: acc.opened + t.opened, resolved: acc.resolved + t.resolved }), { opened: 0, resolved: 0 });
  const cols = trend.map((t, i) => {
    const opened = h("span", { class: `col-bar opened${t.opened ? "" : " zero"}` });
    const resolved = h("span", { class: `col-bar resolved${t.resolved ? "" : " zero"}` });
    opened.style.height = `${(t.opened / max) * 100}%`;
    resolved.style.height = `${(t.resolved / max) * 100}%`;
    const date = dayFmt.format(new Date(`${t.day}T12:00:00Z`));
    return h("div", { class: "chart-col", title: `${date}: ${t.opened} opened, ${t.resolved} resolved` },
      h("div", { class: "chart-bars" }, opened, resolved),
      h("span", { class: "chart-x" }, i % 2 === 0 || i === trend.length - 1 ? date : ""));
  });
  return h("div", {},
    h("div", { class: "legend" }, h("span", {}, h("i", { class: "swatch opened" }), `Opened (${totals.opened})`), h("span", {}, h("i", { class: "swatch resolved" }), `Resolved (${totals.resolved})`)),
    h("div", { class: "chart", role: "img", "aria-label": `Last 14 days: ${totals.opened} tickets opened, ${totals.resolved} resolved` }, cols));
}

function breakdown(title, counts, order, tones) {
  const total = order.reduce((sum, key) => sum + (counts[key] || 0), 0);
  const bar = h("div", { class: "stack-bar" });
  for (const key of order) {
    if (!counts[key]) continue;
    const seg = h("span", { class: `seg ${tones[key]}`, title: `${label(key)}: ${counts[key]}` });
    seg.style.width = `${(counts[key] / total) * 100}%`;
    bar.append(seg);
  }
  return h("div", { class: "breakdown" },
    h("div", { class: "breakdown-head" }, h("h3", {}, title), h("span", { class: "muted small" }, `${total} active`)),
    total ? bar : h("div", { class: "stack-bar empty-bar" }),
    h("ul", { class: "breakdown-legend" }, order.map((key) => h("li", {}, h("i", { class: `swatch ${tones[key]}` }), h("span", { class: "grow" }, label(key)), h("strong", {}, counts[key] || 0)))));
}

function ticketList(items) {
  if (!items.length) return empty("No open tickets", "New requests appear here.");
  return h("ul", { class: "ticket-feed" }, items.map((t) => h("li", {}, h("a", { href: `#/tickets/${t.id}` },
    h("span", { class: `prio-dot ${t.priority}`, title: label(t.priority) }),
    h("span", { class: "grow" }, h("strong", { class: "block" }, t.title), h("small", { class: "muted" }, `${t.number} · ${t.organizationName} · ${fmtRelative(t.createdAt)}`)),
    t.breached ? badge("breached", "SLA breached") : null, badge(t.status)))));
}

function healthList(health) {
  return h("ul", { class: "health-list" }, Object.entries(health).map(([name, item]) => h("li", {},
    h("div", {}, h("strong", {}, HEALTH_NAMES[name] || label(name)), h("small", { class: "muted" }, item.detail || "")),
    h("div", { class: "right" }, badge(item.status), item.checkedAt ? h("small", { class: "muted" }, fmtRelative(item.checkedAt)) : null))));
}

const ACTIONS = {
  "admin.setup": "created the administrator account",
  "login.succeeded": "signed in",
  "login.failed": "had a failed sign-in",
  "login.mfa_failed": "entered a wrong two-factor code",
  "login.blocked_suspended": "was blocked from signing in (suspended)",
  logout: "signed out",
  "password.change": "changed their password",
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
  "ticket.create": "opened a ticket",
  "ticket.update": "updated a ticket",
  "attachment.upload": "attached a file",
  "attachment.download": "downloaded an attachment",
  "device.create": "added a device",
  "device.update": "updated a device",
  "device.archive": "archived a device",
  "device.export": "exported the device list",
  "device.consent": "gave remote-support consent",
  "device.consent_revoke": "revoked remote-support consent",
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
  "payment.record": "recorded a payment",
  "payment.verify": "verified a payment",
  "payment.reject": "rejected a payment",
  "sla_policy.create": "created an SLA policy",
  "sla_policy.update": "updated an SLA policy",
  "holiday.create": "added a holiday",
  "holiday.delete": "removed a holiday",
  "settings.update": "changed settings",
  "backup.create": "created a backup",
  "meshcentral.check": "checked MeshCentral",
  "meshcentral.sync": "synchronized MeshCentral devices",
};

function activityFeed(items) {
  if (!items.length) return empty("No activity yet");
  return h("ul", { class: "activity" }, items.map((a) => h("li", {},
    h("span", { class: `activity-dot${/failed|blocked/.test(a.action) ? " bad" : ""}` }),
    h("div", { class: "grow" }, h("span", {}, h("strong", {}, a.actorName), " ", ACTIONS[a.action] || a.action.replace(/[._]/g, " "), a.organizationName ? h("span", { class: "muted" }, ` · ${a.organizationName}`) : null),
      h("small", { class: "muted block" }, fmtRelative(a.at))))));
}

export function staffDashboard(main, d, actions) {
  const admin = state.me.role === "admin";
  const monitorsUp = d.monitors.total - d.monitors.down - d.monitors.stale - d.monitors.unknown;
  const kpis = h("div", { class: "kpis" },
    kpi("Open tickets", d.tickets.open, { iconName: "ticket", tone: d.tickets.urgent ? "bad" : "info", hint: `${d.tickets.unassigned} unassigned · ${d.tickets.urgent} urgent`, href: "#/tickets" }),
    kpi(admin ? "Assigned to me" : "My queue", d.tickets.mine, { iconName: "user", tone: "accent", hint: d.tickets.dueSoon ? `${d.tickets.dueSoon} reply due soon` : "Nothing due in the next 2 hours", href: "#/tickets?assigned=me" }),
    kpi("Devices online", `${d.devices.online || 0} / ${d.devices.total || 0}`, {
      iconName: "device", tone: d.devices.offline ? "warn" : "ok", href: "#/devices",
      meter: d.devices.total ? (d.devices.online || 0) / d.devices.total : 0,
      hint: `${d.devices.offline || 0} offline · ${d.devices.unknown || 0} not checked`,
    }),
    kpi("Monitors up", d.monitors.total ? `${Math.max(0, monitorsUp)} / ${d.monitors.total}` : "—", {
      iconName: "pulse", tone: d.monitors.down ? "bad" : d.monitors.stale ? "warn" : "ok", href: "#/monitoring",
      meter: d.monitors.total ? Math.max(0, monitorsUp) / d.monitors.total : null,
      hint: d.monitors.total ? `${d.monitors.down} down · ${d.monitors.stale} stale` : "No monitors yet",
    }),
    admin
      ? kpi("Verified this month", money(d.finance.verifiedThisMonth), { iconName: "money", tone: "ok", hint: `${money(d.finance.pendingAmount)} waiting for verification`, href: "#/billing" })
      : kpi("Maintenance overdue", d.maintenanceOverdue, { iconName: "wrench", tone: d.maintenanceOverdue ? "warn" : "ok", hint: `${d.maintenanceDueWeek} due this week`, href: "#/maintenance" }),
  );

  const statusTones = { new: "info", open: "primary", in_progress: "accent", pending_customer: "warn" };
  const priorityTones = { urgent: "bad", high: "warn", normal: "info", low: "muted" };

  const sections = [
    h("div", { class: "dash-hero" },
      h("div", {}, h("p", { class: "eyebrow" }, todayLine()), h("h1", {}, `Good ${greeting()}, ${state.me.name.split(" ")[0]}`),
        h("p", { class: "muted" }, admin ? "Here is what needs you across OSVIA Business Care today." : "Your queue and the systems you look after.")),
      h("div", { class: "page-actions" }, button("Refresh", () => window.dispatchEvent(new HashChangeEvent("hashchange")), { kind: "ghost", iconName: "refresh" }), actions)),
    attentionCard(d, admin),
    kpis,
    h("div", { class: "dash-grid" },
      card("Ticket activity · last 14 days", trendChart(d.trend), { cls: "span-2" }),
      card("Open work", [breakdown("By status", d.byStatus, STATUS_ORDER, statusTones), breakdown("By priority", d.byPriority, PRIORITY_ORDER, priorityTones)])),
    h("div", { class: "dash-grid" },
      card("Latest active tickets", ticketList(d.recentTickets), { cls: "span-2", actions: h("a", { href: "#/tickets", class: "link" }, "View all tickets") }),
      card("System health", healthList(d.health), { actions: admin ? h("a", { href: "#/settings?tab=system", class: "link" }, "Details") : null })),
  ];
  if (admin) {
    sections.push(h("div", { class: "dash-grid" },
      card("Business", h("dl", { class: "biz" },
        bizItem("Active organizations", d.organizationsActive, "#/organizations"),
        bizItem("Awaiting approval", d.organizationsPending, "#/organizations?status=pending", d.organizationsPending ? "warn" : ""),
        bizItem("Payments to verify", `${d.paymentsPending} · ${money(d.finance.pendingAmount)}`, "#/billing", d.paymentsPending ? "warn" : ""),
        bizItem("Outstanding invoices", money(d.finance.outstanding), "#/billing?tab=invoices"),
        bizItem("Overdue invoices", d.invoicesOverdue, "#/billing?tab=invoices", d.invoicesOverdue ? "bad" : ""),
        bizItem("Renewals in 14 days", d.renewalsDue, "#/organizations")), { cls: "span-2" }),
      card("Recent activity", activityFeed(d.activity), { actions: h("a", { href: "#/audit", class: "link" }, "Audit log") })));
  }
  clear(main, ...sections);
}

function bizItem(title, value, href, tone = "") {
  return h("a", { class: `biz-item ${tone}`, href }, h("dt", {}, title), h("dd", {}, value));
}

export function securitySetupPage(main) {
  const steps = h("ol", { class: "setup-steps" },
    h("li", {}, h("strong", {}, "Install an authenticator app"), h("span", { class: "muted" }, " such as Google Authenticator, Microsoft Authenticator or Authy on your phone.")),
    h("li", {}, h("strong", {}, "Add the setup key"), h("span", { class: "muted" }, " shown below as a time-based account.")),
    h("li", {}, h("strong", {}, "Enter the 6-digit code"), h("span", { class: "muted" }, " to unlock the dashboard and all staff tools.")));
  const area = h("div", { class: "setup-area" });
  const startBtn = button("Start setup", async () => {
    const start = await api("POST", "/api/me/mfa/start");
    const code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, placeholder: "123456", "aria-label": "6-digit code", class: "code-input" });
    const error = h("p", { class: "form-error", role: "alert" });
    const form = h("form", { class: "setup-form", onsubmit: async (event) => {
      event.preventDefault();
      error.textContent = "";
      try {
        await api("POST", "/api/me/mfa/confirm", { code: code.value.trim() });
        toast("Two-factor authentication is on. Welcome to your dashboard.");
        location.hash = "#/dashboard";
        location.reload();
      } catch (err) {
        error.textContent = err.message;
      }
    } }, code, button("Turn on and continue", null, { kind: "primary", type: "submit", iconName: "check" }), error);
    clear(area,
      h("p", { class: "muted small" }, "Setup key"),
      h("div", { class: "secret-key mono" }, start.secret.replace(/(.{4})/g, "$1 ").trim()),
      h("p", { class: "small" }, "On a phone with the app installed you can also ", h("a", { href: start.otpauth }, "open this link"), " to add it."),
      form);
    code.focus();
  }, { kind: "primary", iconName: "shield" });
  area.append(startBtn);
  clear(main,
    h("div", { class: "security-gate" },
      h("div", { class: "gate-icon" }, icon("lock")),
      h("h1", {}, `Welcome, ${state.me.name.split(" ")[0]}. Secure your account first`),
      h("p", { class: "muted" }, "OSVIA staff accounts can reach every customer's tickets, devices and billing, so two-factor authentication is required before the dashboard opens. It takes about a minute."),
      card(null, [steps, area])));
}
