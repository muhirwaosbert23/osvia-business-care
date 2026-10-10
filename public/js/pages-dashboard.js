import { api, badge, button, card, clear, empty, errorBox, fmtDate, fmtDateTime, fmtRelative, h, icon, isRole, label, money, skeleton, state, toast } from "./core.js";
import { actionText } from "./history.js";

const STATUS_ORDER = ["new", "open", "in_progress", "pending_customer"];
const PRIORITY_ORDER = ["urgent", "high", "normal", "low"];
const HEALTH_NAMES = { meshcentral: "MeshCentral", smtp: "Email (SMTP)", monitor_runner: "Monitoring checks", device_runner: "Device checks", scheduler: "Background jobs", backup: "Backups" };

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

function activityFeed(items) {
  if (!items.length) return empty("No activity yet");
  return h("ul", { class: "activity" }, items.map((a) => h("li", {},
    h("span", { class: `activity-dot${/failed|blocked/.test(a.action) ? " bad" : ""}` }),
    h("div", { class: "grow" }, h("span", {}, h("strong", {}, a.actorName), " ", actionText(a.action), a.organizationName ? h("span", { class: "muted" }, ` · ${a.organizationName}`) : null),
      h("small", { class: "muted block" }, fmtRelative(a.at))))));
}

function deviceTile(dev) {
  return h("a", { class: `device-tile ${dev.reachability}`, href: `#/devices/${dev.id}` },
    h("div", { class: "device-tile-top" }, h("strong", {}, dev.name), badge(dev.reachability)),
    h("small", { class: "muted block" }, [dev.organizationName, dev.assignedUserName].filter(Boolean).join(" · ") || "Unassigned"),
    h("small", { class: "muted block" }, dev.lastChecked ? `Checked ${fmtRelative(dev.lastChecked)}` : "Not checked yet"),
    dev.hasLocation ? h("small", { class: "muted block" }, "On the map") : null);
}

function dashboardMap(devices) {
  if (!devices?.length) {
    return empty("No devices on the map yet", "Open Map to read MeshCentral GPS and public IPs.");
  }
  const first = devices[0];
  return h("div", { class: "dash-map" },
    h("iframe", { class: "gmap", src: first.location.embedUrl, title: `Google Map of ${first.name}`, loading: "lazy", referrerpolicy: "origin", allow: "fullscreen" }),
    h("div", { class: "fleet-meta" },
      h("div", {}, h("strong", {}, first.name), h("small", { class: "muted block" }, first.location.label || first.organizationName)),
      h("div", { class: "row-actions" },
        h("a", { class: "btn small primary", href: first.location.mapsUrl, target: "_blank", rel: "noopener" }, "Open in Google Maps"),
        h("a", { class: "btn small ghost", href: "#/map" }, "All devices"))),
    h("ul", { class: "mini-list" }, devices.slice(0, 8).map((item) => h("li", {},
      h("a", { href: `#/devices/${item.id}` }, item.name), badge(item.reachability),
      h("a", { class: "small", href: item.location.mapsUrl, target: "_blank", rel: "noopener" }, "Google Maps")))));
}

function changeLine(c, staff) {
  return h("li", {},
    h("span", { class: `activity-dot ${c.status === "offline" ? "bad" : "ok"}` }),
    h("div", { class: "grow" },
      h("a", { href: `#/devices/${c.deviceId}` }, h("strong", {}, c.deviceName), ` ${c.status === "offline" ? "went offline" : "came online"}`, staff && c.organizationName ? h("span", { class: "muted" }, ` · ${c.organizationName}`) : null),
      h("small", { class: "muted block" }, fmtRelative(c.at))));
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
    kpi("On the map", d.devices.onMap || 0, { iconName: "map", tone: d.devices.onMap ? "ok" : "warn", hint: d.devices.onMap ? "MeshCentral GPS or public IP" : "Open Map to detect devices", href: "#/map" }),
    kpi("Remote ready", d.devices.remoteReady || 0, { iconName: "remote", tone: d.devices.remoteReady ? "ok" : "warn", hint: "Consented MeshCentral agents", href: "#/remote" }),
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
      h("div", { class: "page-actions" }, button("Refresh", () => loadDashboard(main), { kind: "ghost", iconName: "refresh" }), actions)),
    attentionCard(d, admin),
    kpis,
    h("div", { class: "dash-grid" },
      card("Ticket activity · last 14 days", trendChart(d.trend), { cls: "span-2" }),
      card("Open work", [breakdown("By status", d.byStatus, STATUS_ORDER, statusTones), breakdown("By priority", d.byPriority, PRIORITY_ORDER, priorityTones)])),
    h("div", { class: "dash-grid" },
      card("Devices right now", d.liveDevices?.length ? h("div", { class: "device-grid" }, d.liveDevices.map(deviceTile)) : empty("No devices yet"), { cls: "span-2", actions: h("span", { class: "row-actions" }, h("a", { href: "#/map", class: "link" }, "Map"), h("a", { href: "#/devices", class: "link" }, "All devices")) }),
      card("Live map", dashboardMap(d.mapDevices), { actions: h("a", { href: "#/map", class: "link" }, "Open map") })),
    h("div", { class: "dash-grid" },
      card("Status changes", d.statusChanges?.length ? h("ul", { class: "activity" }, d.statusChanges.map((c) => changeLine(c, true))) : empty("No status changes yet. Checks run every 15 seconds."), { cls: "span-2" })),
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

function customerAttention(d) {
  const items = [
    [d.tickets.waitingOnYou, "Waiting on your reply", "warn", "#/tickets?status=pending_customer", "clock"],
    [d.tickets.resolved, "Resolved — confirm they are fixed", "info", "#/tickets?status=resolved", "check"],
    [d.devices.offline, "Devices offline", "bad", "#/devices?reachability=offline", "device"],
    [d.incidentsOpen, "Open incidents", "bad", "#/status", "alert"],
    [(d.monitors || []).filter((m) => m.status === "down").length, "Websites down", "bad", "#/status", "pulse"],
  ];
  if (d.billing) {
    items.push(
      [d.billing.overdue, "Overdue invoices", "bad", "#/billing", "money"],
      [d.billing.unpaid, "Unpaid invoices", "warn", "#/billing", "money"],
    );
  }
  return items.filter(([count]) => count > 0);
}

export function customerDashboard(main, d, actions) {
  const org = d.organization;
  const offline = d.devices.offline || 0;
  const items = customerAttention(d);
  const banners = [];
  if (org.status === "pending") banners.push(h("div", { class: "banner warn" }, h("strong", {}, "OSVIA is reviewing your registration."), " You can explore the portal. Support requests open once your organization is approved."));
  if (org.subscriptionStatus === "past_due") banners.push(h("div", { class: "banner bad" }, h("strong", {}, "Your renewal is overdue."), " Pay the open invoice to keep full service. ", isRole("customer_admin") ? h("a", { href: "#/billing" }, "View billing") : null));
  if (d.onboardingIncomplete) banners.push(h("div", { class: "banner info" }, h("strong", {}, "Finish setting up."), " Follow the checklist to get full support. ", h("a", { href: "#/organization" }, "Open checklist")));
  if (d.windows?.length) banners.push(...d.windows.map((w) => h("div", { class: "banner info" }, icon("calendar"), h("strong", {}, ` Planned maintenance: ${w.title}`), ` from ${fmtDateTime(w.startsAt)} to ${fmtDateTime(w.endsAt)}.`)));
  const attention = items.length
    ? h("section", { class: "attention", "aria-label": "Needs attention" }, h("h2", {}, "Needs attention"),
      h("div", { class: "attention-list" }, items.map(([count, text, tone, href, iconName]) => h("a", { class: `attention-item ${tone}`, href }, icon(iconName), h("span", { class: "attention-count" }, count), h("span", {}, text)))))
    : h("section", { class: "attention clear-state" }, h("span", { class: "kpi-icon ok" }, icon("check")), h("div", {}, h("strong", {}, "All clear"), h("p", { class: "muted small" }, "Your devices and websites are answering checks. Nothing is waiting on you.")));
  clear(main,
    h("div", { class: "dash-hero" },
      h("div", {}, h("p", { class: "eyebrow" }, todayLine()), h("h1", {}, org.name),
        h("p", { class: "muted" }, `${org.planName ? `${org.planName} plan` : "No plan yet"} · ${label(org.subscriptionStatus)}${org.renewalDate ? ` · renews ${fmtDate(org.renewalDate)}` : ""} · checks run every 15 seconds`)),
      h("div", { class: "page-actions" }, button("Refresh", () => loadDashboard(main), { kind: "ghost", iconName: "refresh" }), org.status === "active" ? actions : [])),
    banners,
    attention,
    h("div", { class: "kpis" },
      kpi("Devices online", `${d.devices.online || 0} / ${d.devices.total || 0}`, {
        iconName: "device", tone: offline ? "bad" : "ok", href: "#/devices",
        meter: d.devices.total ? (d.devices.online || 0) / d.devices.total : 0,
        hint: offline ? `${offline} offline now` : "All checked devices are answering",
      }),
      kpi("Open tickets", d.tickets.open, { iconName: "ticket", tone: d.tickets.waitingOnYou ? "warn" : "info", hint: `${d.tickets.waitingOnYou} waiting on you`, href: "#/tickets" }),
      kpi("Websites", d.monitors?.length ? `${d.monitors.filter((m) => m.status === "up").length} / ${d.monitors.length} up` : "—", {
        iconName: "pulse", tone: (d.monitors || []).some((m) => m.status === "down") ? "bad" : "ok", href: "#/status",
        hint: d.monitors?.length ? "Last 24 hours" : "Add a website under Websites & status",
      }),
      kpi("Open incidents", d.incidentsOpen, { iconName: "alert", tone: d.incidentsOpen ? "bad" : "ok", href: "#/status" }),
      d.billing ? kpi("Unpaid invoices", d.billing.unpaid, { iconName: "money", tone: d.billing.overdue ? "bad" : "", hint: d.billing.pending ? `${d.billing.pending} payment(s) being verified` : "", href: "#/billing" }) : null),
    card(isRole("customer_user") ? "My devices" : "Your devices", d.liveDevices?.length ? h("div", { class: "device-grid" }, d.liveDevices.map(deviceTile)) : empty("No devices yet", isRole("customer_admin") ? "Add the computers OSVIA looks after so you can see when they go offline." : "Ask your administrator to assign devices to you."), { actions: h("a", { href: "#/devices", class: "link" }, "All devices") }),
    d.monitors?.length ? card("Websites", h("div", { class: "site-grid" }, d.monitors.map((m) => h("a", { class: `site-card ${m.status}`, href: `#/monitoring/${m.id}` },
      h("div", { class: "site-top" }, h("strong", {}, m.name), badge(m.status)),
      h("div", { class: "site-stats" },
        h("span", {}, h("strong", {}, m.uptimePercent === null ? "No data" : `${m.uptimePercent}%`), h("small", { class: "muted block" }, "uptime 24 h")),
        h("span", {}, h("strong", {}, m.lastResponseMs != null ? `${m.lastResponseMs} ms` : "—"), h("small", { class: "muted block" }, "response")),
        h("span", {}, h("strong", {}, m.lastCheckedAt ? fmtRelative(m.lastCheckedAt) : "never"), h("small", { class: "muted block" }, "last check")))))), { actions: h("a", { href: "#/status", class: "link" }, "Open status") }) : null,
    h("div", { class: "dash-grid" },
      card("Recent requests", ticketList(d.recentTickets), { cls: "span-2", actions: h("a", { href: "#/tickets", class: "link" }, "View all") }),
      card("What just changed", d.statusChanges?.length ? h("ul", { class: "activity" }, d.statusChanges.map((c) => changeLine(c, false))) : empty("Waiting for the first check", "When a machine goes off or comes back on, it appears here immediately."))),
    d.recentIncidents?.length ? card("Incidents", h("ul", { class: "mini-list" }, d.recentIncidents.map((i) => h("li", {}, h("a", { href: `#/incidents/${i.id}` }, h("span", { class: "grow" }, i.title), badge(i.status === "open" ? "down" : "resolved", i.status === "open" ? "Ongoing" : "Resolved"), h("small", { class: "muted" }, fmtRelative(i.startedAt))))))) : null,
    d.upcomingMaintenance?.length ? card("Upcoming maintenance", h("ul", { class: "mini-list" }, d.upcomingMaintenance.map((m) => h("li", {}, h("span", { class: "grow" }, m.title), h("span", { class: "muted" }, fmtDate(m.nextDue)))))) : null,
    state.config.escalation ? card("Urgent problem?", h("p", {}, state.config.escalation, state.config.supportPhone ? h("strong", {}, ` Support line: ${state.config.supportPhone}`) : null), { cls: "subtle" }) : null,
  );
}

export async function loadDashboard(main) {
  if (isRole("admin", "technician") && state.mustEnrollMfa) {
    securitySetupPage(main);
    return;
  }
  const actions = [button("New ticket", async () => {
    const { newTicketDialog } = await import("./pages-main.js");
    await newTicketDialog(() => loadDashboard(main));
  }, { kind: "primary", iconName: "plus" })];
  try {
    const d = await api("GET", "/api/dashboard");
    if (isRole("admin", "technician")) staffDashboard(main, d, actions);
    else customerDashboard(main, d, actions);
  } catch (error) {
    clear(main, errorBox(error, () => loadDashboard(main)));
  }
}
