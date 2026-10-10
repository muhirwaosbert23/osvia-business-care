import {
  api, badge, button, card, clear, confirmDialog, dataTable, definitionList, empty, errorBox, fmtDate, fmtDateTime, fmtRelative, formDialog, h, isRole, isStaff,
  label, orgOptions, pageHeader, skeleton, toast, toLocalInput,
} from "./core.js";
import { historyCard } from "./history.js";
import { uptimeBars } from "./pages-assets.js";

function uptimeText(value) {
  return value === null || value === undefined ? "No data" : `${value}%`;
}

export function monitoringPage(main) {
  if (!isStaff()) {
    location.hash = "#/status";
    return;
  }
  const staff = true;
  const table = dataTable({
    columns: [
      { label: "Monitor", render: (m) => h("div", {}, h("strong", {}, m.name), h("small", { class: "muted block" }, [m.organizationName, staff ? m.target : label(m.type)].filter(Boolean).join(" · "))) },
      { label: "Type", render: (m) => m.type.toUpperCase() },
      { label: "Status", render: (m) => badge(m.status, m.status === "stale" ? "Stale (no recent check)" : null) },
      { label: "Uptime 24 h", render: (m) => uptimeText(m.uptimePercent) },
      { label: "Response", render: (m) => (m.lastResponseMs !== null && m.lastResponseMs !== undefined ? `${m.lastResponseMs} ms` : "—") },
      { label: "Certificate", render: (m) => (m.sslExpiresAt ? h("span", { class: Date.parse(m.sslExpiresAt) - Date.now() < 14 * 86400000 ? "text-warn" : "" }, `Expires ${fmtRelative(m.sslExpiresAt)}`) : "—") },
      { label: "Last check", render: (m) => (m.lastCheckedAt ? fmtRelative(m.lastCheckedAt) : "Never") },
    ],
    searchPlaceholder: null,
    load: (q) => api("GET", `/api/monitors?${q}`),
    rowHref: (m) => `#/monitoring/${m.id}`,
    emptyText: staff ? "No monitors yet. Add websites, servers or network devices to watch." : "OSVIA is not monitoring any services for you yet.",
  });
  clear(main, pageHeader("Monitoring", "Availability, response time and certificate checks run from the OSVIA server. Stale means checks have stopped arriving.", [
    staff ? button("Maintenance windows", () => { location.hash = "#/maintenance-windows"; }, { kind: "ghost", iconName: "calendar" }) : null,
    staff ? button("Add monitor", () => monitorDialog(null, () => table.refresh()), { kind: "primary", iconName: "plus" }) : null,
  ]), table.el);
}

function websiteDialog(monitor, onDone) {
  formDialog(monitor ? `Edit ${monitor.name}` : "Monitor a website", [
    monitor ? null : { type: "note", label: "OSVIA checks the address every 5 minutes from its server, measures the response time, and warns you before the security certificate expires. If it stops responding, an incident opens and you are notified." },
    { name: "name", label: "Name", required: true, max: 120, value: monitor?.name, placeholder: "e.g. Company website" },
    { name: "target", label: "Website address", required: true, max: 500, value: monitor?.target, placeholder: "https://www.example.co.ug" },
    monitor ? { name: "active", label: "Checking is on", type: "checkbox", value: monitor.active } : null,
    monitor ? { name: "reason", label: "Reason for the change (optional)", max: 300 } : null,
  ].filter(Boolean), async (values, close) => {
    const body = { ...values };
    if (!body.reason) delete body.reason;
    if (monitor) await api("PATCH", `/api/monitors/${monitor.id}`, body);
    else await api("POST", "/api/monitors", body);
    close();
    toast(monitor ? "Saved." : "Website added. The first check runs within a minute.");
    onDone?.();
  }, { submitLabel: monitor ? "Save" : "Start monitoring" });
}

function responseChart(checks) {
  const points = [...checks].reverse().filter((c) => c.ok && c.responseMs !== null);
  if (points.length < 2) return empty("Not enough data yet", "The response-time chart appears after a few successful checks.");
  const w = 600;
  const hgt = 160;
  const max = Math.max(...points.map((p) => p.responseMs)) * 1.15;
  const t0 = Date.parse(points[0].checkedAt);
  const span = Math.max(1, Date.parse(points[points.length - 1].checkedAt) - t0);
  const xy = points.map((p) => [((Date.parse(p.checkedAt) - t0) / span) * w, hgt - (p.responseMs / max) * hgt]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "resp-chart");
  svg.setAttribute("role", "img");
  const avg = Math.round(points.reduce((s, p) => s + p.responseMs, 0) / points.length);
  svg.setAttribute("aria-label", `Response time over the last ${points.length} successful checks, average ${avg} ms`);
  const area = document.createElementNS(ns, "path");
  area.setAttribute("d", `${line} L${w},${hgt} L0,${hgt} Z`);
  area.setAttribute("class", "resp-area");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", line);
  path.setAttribute("class", "resp-line");
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(area, path);
  const sorted = points.map((p) => p.responseMs).sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return h("div", {},
    h("div", { class: "legend" }, h("span", {}, `Average ${avg} ms`), h("span", {}, `Fastest ${sorted[0]} ms`), h("span", {}, `95% under ${p95} ms`), h("span", {}, `Slowest ${sorted[sorted.length - 1]} ms`)),
    h("div", { class: "resp-wrap" }, h("span", { class: "resp-max muted small" }, `${Math.round(max)} ms`), svg),
    h("div", { class: "resp-x muted small" }, h("span", {}, fmtDateTime(points[0].checkedAt)), h("span", {}, fmtDateTime(points[points.length - 1].checkedAt))));
}

async function monitorDialog(monitor, onDone) {
  const fields = [];
  if (!monitor) fields.push({ name: "organizationId", label: "Organization", type: "select", required: true, options: await orgOptions() });
  fields.push(
    { name: "name", label: "Name", required: true, max: 120, value: monitor?.name, placeholder: "e.g. Company website" },
    { name: "type", label: "Check type", type: "select", options: [["http", "Website (HTTP/HTTPS)"], ["tcp", "TCP port"], ["ping", "Ping"]], value: monitor?.type || "http" },
    { name: "target", label: "URL or host", required: true, max: 500, value: monitor?.target, placeholder: "https://example.co.ug or 192.168.1.10" },
    { name: "port", label: "Port (TCP only)", type: "number", min: 1, maxValue: 65535, value: monitor?.port ?? "" },
    { name: "intervalSeconds", label: "Check every (seconds)", type: "number", min: 60, maxValue: 86400, value: monitor?.intervalSeconds ?? 300 },
    { name: "failureThreshold", label: "Failures before an incident", type: "number", min: 1, maxValue: 10, value: monitor?.failureThreshold ?? 2 },
    { name: "timeoutMs", label: "Timeout (ms)", type: "number", min: 1000, maxValue: 30000, value: monitor?.timeoutMs ?? 10000 },
    { name: "expectedStatus", label: "Healthy HTTP status", max: 60, value: monitor?.expectedStatus ?? "200-399" },
    { name: "sslWarningDays", label: "Warn before certificate expiry (days)", type: "number", min: 1, maxValue: 120, value: monitor?.sslWarningDays ?? 14 },
    { name: "customerVisible", label: "Show to the customer", type: "checkbox", value: monitor ? monitor.customerVisible : true },
    monitor ? { name: "active", label: "Active", type: "checkbox", value: monitor.active } : null,
  );
  formDialog(monitor ? `Edit ${monitor.name}` : "Add monitor", fields.filter(Boolean), async (values, close) => {
    const body = { ...values };
    if (body.organizationId) body.organizationId = Number(body.organizationId);
    if (body.type !== "tcp") delete body.port;
    if (monitor) await api("PATCH", `/api/monitors/${monitor.id}`, body);
    else await api("POST", "/api/monitors", body);
    close();
    toast("Monitor saved.");
    onDone?.();
  }, { wide: true });
}

export async function monitorDetailPage(main, id) {
  clear(main, skeleton(6));
  let data;
  try {
    data = await api("GET", `/api/monitors/${id}`);
  } catch (error) {
    clear(main, pageHeader("Monitor"), errorBox(error, () => monitorDetailPage(main, id)));
    return;
  }
  const m = data.monitor;
  const staff = isStaff();
  const reload = () => monitorDetailPage(main, id);
  const bars = h("div", { class: "checkbar", role: "img", "aria-label": "Recent checks, oldest first" }, [...data.checks].reverse().map((c) => {
    const el = h("span", { class: c.ok ? "ok" : "bad", title: `${fmtDateTime(c.checkedAt)} · ${c.ok ? `${c.responseMs ?? "?"} ms` : c.error || "failed"}` });
    return el;
  }));
  const back = staff ? "#/monitoring" : "#/status";
  const actions = [];
  if (staff) actions.push(button("Check now", async () => {
    const r = await api("POST", `/api/monitors/${m.id}/run`);
    toast(`Status: ${label(r.monitor.status)}`);
    reload();
  }, { kind: "ghost", iconName: "refresh" }));
  if (m.canManage) {
    actions.push(button("Edit", () => (m.addedByCustomer ? websiteDialog(m, reload) : monitorDialog(m, reload)), { kind: "ghost" }));
    actions.push(button("Delete", async () => {
      if (!(await confirmDialog("Delete monitor", "Monitors with incident history are paused instead of deleted, to keep the record.", { danger: true, confirmLabel: "Delete" }))) return;
      const r = await api("DELETE", `/api/monitors/${m.id}`);
      toast(r.message || "Monitor deleted.");
      location.hash = back;
    }, { kind: "ghost danger-text" }));
  }
  const certDays = m.sslExpiresAt ? Math.floor((Date.parse(m.sslExpiresAt) - Date.now()) / 86400000) : null;
  clear(main,
    h("a", { href: back, class: "back" }, staff ? "← Monitoring" : "← Websites & status"),
    pageHeader(m.name, [staff ? m.organizationName : null, m.type.toUpperCase(), m.target ? `${m.target}${m.port ? `:${m.port}` : ""}` : null, m.addedByCustomer ? `added by ${m.createdByName || "the customer"}` : null].filter(Boolean).join(" · "), actions),
    !m.active ? h("div", { class: "banner warn" }, "Checking is paused. Figures below are from earlier checks.") : null,
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Status"), h("span", { class: "stat-value" }, badge(m.status, m.status === "stale" ? "Stale" : null)), h("span", { class: "stat-hint" }, m.lastCheckedAt ? `checked ${fmtRelative(m.lastCheckedAt)}` : "not checked yet")),
      h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Uptime 24 h"), h("span", { class: "stat-value" }, uptimeText(data.day.uptimePercent)), h("span", { class: "stat-hint" }, `${data.day.checks} checks`)),
      h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Uptime 30 days"), h("span", { class: "stat-value" }, uptimeText(data.month.uptimePercent)), h("span", { class: "stat-hint" }, `${data.month.checks} checks`)),
      h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Uptime 90 days"), h("span", { class: "stat-value" }, uptimeText(data.quarter.uptimePercent))),
      h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Average response 24 h"), h("span", { class: "stat-value" }, data.day.avgResponseMs ? `${data.day.avgResponseMs} ms` : "—")),
      m.type === "http" ? h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Certificate"), h("span", { class: `stat-value ${certDays !== null && certDays < 14 ? "text-warn" : ""}` }, certDays === null ? "—" : `${certDays} days`), h("span", { class: "stat-hint" }, m.sslExpiresAt ? `expires ${fmtDate(m.sslExpiresAt)}` : "no HTTPS certificate seen")) : null),
    card("Last 90 days", [uptimeBars(data.daily.map((d) => ({ day: d.day, uptimePercent: d.uptimePercent }))), h("div", { class: "resp-x muted small" }, h("span", {}, "90 days ago"), h("span", {}, "Today"))]),
    card("Response time", responseChart(data.checks)),
    card("Last 100 checks", data.checks.length ? bars : empty("No checks yet", "The first check runs within a minute of creating the monitor.")),
    card("Check log", data.checks.length ? h("div", { class: "table-scroll" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Time"), h("th", {}, "Result"), h("th", {}, "Response"), h("th", {}, "HTTP"), h("th", {}, "Error"))),
      h("tbody", {}, data.checks.slice(0, 30).map((c) => h("tr", {}, h("td", {}, fmtDateTime(c.checkedAt)), h("td", {}, badge(c.ok ? "up" : "down")), h("td", {}, c.responseMs ? `${c.responseMs} ms` : "—"), h("td", {}, c.statusCode ?? "—"), h("td", {}, c.error || "")))))) : null),
    staff ? card("Settings", definitionList([["Interval", `${m.intervalSeconds} s`], ["Timeout", `${m.timeoutMs} ms`], ["Failures before incident", m.failureThreshold], ["Healthy status", m.expectedStatus], ["Visible to customer", m.customerVisible ? "Yes" : "No"], ["Last error", m.lastError]])) : null,
    historyCard("monitor", m.id));
}

export function incidentsPage(main, query) {
  const staff = isStaff();
  const table = dataTable({
    columns: [
      { label: "Incident", render: (i) => h("div", {}, h("strong", {}, i.title), h("small", { class: "muted block" }, [staff ? i.organizationName : null, i.source].filter(Boolean).join(" · "))) },
      { label: "Severity", render: (i) => badge(i.severity) },
      { label: "Status", render: (i) => badge(i.status === "open" ? "down" : "resolved", i.status === "open" ? "Ongoing" : "Resolved") },
      { label: "Started", render: (i) => fmtDateTime(i.startedAt) },
      { label: "Duration", render: (i) => duration(i.durationMinutes) },
      staff ? { label: "Customer sees it", render: (i) => (i.customerVisible ? "Yes" : "No") } : null,
    ].filter(Boolean),
    filters: [{ name: "status", label: "Status", value: query.get("status") || "", options: [["", "All"], ["open", "Ongoing"], ["resolved", "Resolved"]] }],
    searchPlaceholder: null,
    load: (q) => api("GET", `/api/incidents?${q}`),
    rowHref: (i) => `#/incidents/${i.id}`,
    emptyText: "No incidents recorded.",
  });
  clear(main, pageHeader("Incidents", "Outages detected by monitoring or device checks, and problems reported by OSVIA.", staff ? [button("Report incident", () => incidentDialog(() => table.refresh()), { kind: "primary", iconName: "plus" })] : []), table.el);
}

function duration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${Math.floor(minutes / 1440)} d ${Math.floor((minutes % 1440) / 60)} h`;
}

async function incidentDialog(onDone) {
  formDialog("Report an incident", [
    { name: "organizationId", label: "Organization", type: "select", required: true, options: await orgOptions() },
    { name: "title", label: "Title", required: true, max: 160, placeholder: "e.g. Internet outage at head office" },
    { name: "severity", label: "Severity", type: "select", options: [["minor", "Minor"], ["major", "Major"], ["critical", "Critical"]] },
    { name: "summary", label: "Details", type: "textarea", rows: 3, max: 4000, full: true },
    { name: "customerVisible", label: "Show to the customer", type: "checkbox", value: true },
  ], async (values, close) => {
    const res = await api("POST", "/api/incidents", { ...values, organizationId: Number(values.organizationId) });
    close();
    toast("Incident recorded.");
    onDone?.();
    location.hash = `#/incidents/${res.incident.id}`;
  }, { wide: true });
}

export async function incidentDetailPage(main, id) {
  clear(main, skeleton(4));
  let data;
  try {
    data = await api("GET", `/api/incidents/${id}`);
  } catch (error) {
    clear(main, pageHeader("Incident"), errorBox(error, () => incidentDetailPage(main, id)));
    return;
  }
  const i = data.incident;
  const reload = () => incidentDetailPage(main, id);
  const staff = isStaff();
  clear(main,
    h("a", { href: "#/incidents", class: "back" }, "← Incidents"),
    pageHeader(i.title, `${i.organizationName} · ${i.source}`, staff ? [
      button("Edit", () => formDialog("Edit incident", [
        { name: "severity", label: "Severity", type: "select", options: [["minor", "Minor"], ["major", "Major"], ["critical", "Critical"]], value: i.severity },
        { name: "summary", label: "Summary for the record", type: "textarea", rows: 4, max: 4000, value: i.summary, full: true },
        { name: "customerVisible", label: "Show to the customer", type: "checkbox", value: i.customerVisible },
      ], async (values, close) => {
        await api("PATCH", `/api/incidents/${i.id}`, values);
        close();
        reload();
      }), { kind: "ghost" }),
      i.status === "open" ? button("Mark resolved", () => formDialog("Resolve incident", [
        { name: "summary", label: "What happened and how it was fixed", type: "textarea", rows: 4, max: 4000, value: i.summary, full: true, required: true },
      ], async (values, close) => {
        await api("PATCH", `/api/incidents/${i.id}`, { status: "resolved", summary: values.summary });
        close();
        toast("Incident resolved.");
        reload();
      }, { submitLabel: "Resolve" }), { kind: "primary", iconName: "check" }) : null,
    ] : []),
    card(null, definitionList([
      ["Status", badge(i.status === "open" ? "down" : "resolved", i.status === "open" ? "Ongoing" : "Resolved")],
      ["Severity", badge(i.severity)],
      ["Started", fmtDateTime(i.startedAt)],
      ["Resolved", fmtDateTime(i.resolvedAt)],
      ["Duration", duration(i.durationMinutes)],
      ["Summary", i.summary ? h("span", { class: "pre" }, i.summary) : "No summary yet."],
      i.monitorId ? ["Monitor", h("a", { href: `#/monitoring/${i.monitorId}` }, "Open monitor")] : null,
      i.deviceId ? ["Device", h("a", { href: `#/devices/${i.deviceId}` }, "Open device")] : null,
    ])),
    historyCard("incident", i.id));
}

export function windowsPage(main) {
  const table = dataTable({
    columns: [
      { label: "Title", key: "title" },
      { label: "Scope", key: "organizationName" },
      { label: "Starts", render: (w) => fmtDateTime(w.startsAt) },
      { label: "Ends", render: (w) => fmtDateTime(w.endsAt) },
      { label: "", render: (w) => h("div", { class: "row-actions" }, w.active ? badge("pending", "In progress") : null, button(w.active ? "End now" : "Cancel", async () => {
        await api("DELETE", `/api/maintenance-windows/${w.id}`);
        toast("Updated.");
        table.refresh();
      }, { kind: "small ghost" })) },
    ],
    filters: [{ name: "all", label: "Show", value: "", options: [["", "Current and upcoming"], ["1", "Include past"]] }],
    searchPlaceholder: null,
    load: (q) => api("GET", `/api/maintenance-windows?${q}`),
    emptyText: "No maintenance windows.",
  });
  clear(main, h("a", { href: "#/monitoring", class: "back" }, "← Monitoring"), pageHeader("Maintenance windows", "During a window, failed checks do not open incidents or send alerts. Customers see the planned work on their dashboard.", [
    button("Schedule window", async () => formDialog("Schedule maintenance window", [
      { name: "organizationId", label: "Organization", type: "select", options: [["", "All organizations"], ...(await orgOptions())] },
      { name: "title", label: "Title", required: true, max: 160, placeholder: "e.g. Router firmware upgrade" },
      { name: "startsAt", label: "Starts", type: "datetime-local", required: true, value: toLocalInput(new Date(Date.now() + 3600000).toISOString()) },
      { name: "endsAt", label: "Ends", type: "datetime-local", required: true, value: toLocalInput(new Date(Date.now() + 7200000).toISOString()) },
    ], async (values, close) => {
      await api("POST", "/api/maintenance-windows", { ...values, organizationId: values.organizationId ? Number(values.organizationId) : null });
      close();
      toast("Window scheduled.");
      table.refresh();
    }), { kind: "primary", iconName: "calendar" }),
  ]), table.el);
}

export async function statusPage(main) {
  clear(main, pageHeader("Service status"), skeleton(4));
  try {
    const [monitors, incidents, windows] = await Promise.all([api("GET", "/api/monitors?limit=100"), api("GET", "/api/incidents?limit=10"), api("GET", "/api/maintenance-windows")]);
    const open = incidents.items.filter((i) => i.status === "open");
    const allUp = monitors.items.length && monitors.items.every((m) => m.status === "up" || m.status === "paused");
    const canAdd = isRole("customer_admin");
    const reload = () => statusPage(main);
    clear(main, pageHeader("Websites & status", "Your websites and services, checked around the clock from the OSVIA server.", canAdd ? [button("Monitor a website", () => websiteDialog(null, reload), { kind: "primary", iconName: "plus" })] : []),
      open.length ? h("div", { class: "banner bad" }, h("strong", {}, `${open.length} ongoing incident(s). `), "OSVIA is working on it.")
        : monitors.items.length ? h("div", { class: `banner ${allUp ? "ok" : "warn"}` }, allUp ? "All monitored services are responding." : "Some services are down or have not reported a recent successful check.") : null,
      windows.items.map((w) => h("div", { class: "banner info" }, h("strong", {}, `Planned maintenance: ${w.title}`), ` ${fmtDateTime(w.startsAt)} to ${fmtDateTime(w.endsAt)}`)),
      monitors.items.length ? h("div", { class: "site-grid" }, monitors.items.map((m) => h("a", { class: `site-card ${m.status}`, href: `#/monitoring/${m.id}` },
        h("div", { class: "site-top" }, h("strong", {}, m.name), badge(m.status, m.status === "stale" ? "Stale" : null)),
        m.target ? h("small", { class: "muted block site-url" }, m.target) : h("small", { class: "muted block" }, `${m.type.toUpperCase()} check`),
        h("div", { class: "site-stats" },
          h("span", {}, h("strong", {}, uptimeText(m.uptimePercent)), h("small", { class: "muted block" }, "uptime 24 h")),
          h("span", {}, h("strong", {}, m.lastResponseMs !== null && m.lastResponseMs !== undefined ? `${m.lastResponseMs} ms` : "—"), h("small", { class: "muted block" }, "response")),
          h("span", {}, h("strong", {}, m.lastCheckedAt ? fmtRelative(m.lastCheckedAt) : "never"), h("small", { class: "muted block" }, "last check"))),
        m.addedByCustomer ? h("small", { class: "muted" }, "Added by your organization") : h("small", { class: "muted" }, "Managed by OSVIA")))) : card(null, empty("Nothing monitored yet", canAdd ? "Add your website and OSVIA will check it every 5 minutes, alert you when it goes down, and warn before its certificate expires." : "Ask your administrator or OSVIA to monitor your website.", canAdd ? button("Monitor a website", () => websiteDialog(null, reload), { kind: "primary", iconName: "plus" }) : null)),
      card("Recent incidents", incidents.items.length ? h("ul", { class: "mini-list" }, incidents.items.map((i) => h("li", {}, h("a", { href: `#/incidents/${i.id}` }, h("span", { class: "grow" }, i.title), h("small", { class: "muted" }, fmtDateTime(i.startedAt)), badge(i.status === "open" ? "down" : "resolved", i.status === "open" ? "Ongoing" : "Resolved"))))) : empty("No incidents")));
  } catch (error) {
    clear(main, pageHeader("Service status"), errorBox(error, () => statusPage(main)));
  }
}
