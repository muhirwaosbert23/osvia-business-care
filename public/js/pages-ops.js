import {
  api, badge, button, card, clear, confirmDialog, dataTable, definitionList, empty, errorBox, fmtDateTime, fmtRelative, formDialog, h, isStaff,
  label, orgOptions, pageHeader, skeleton, toast, toLocalInput,
} from "./core.js";

function uptimeText(value) {
  return value === null || value === undefined ? "No data" : `${value}%`;
}

export function monitoringPage(main) {
  const staff = isStaff();
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
  clear(main,
    h("a", { href: "#/monitoring", class: "back" }, "← Monitoring"),
    pageHeader(m.name, `${m.organizationName} · ${m.type.toUpperCase()}${staff ? ` · ${m.target}${m.port ? `:${m.port}` : ""}` : ""}`, staff ? [
      button("Check now", async () => {
        const r = await api("POST", `/api/monitors/${m.id}/run`);
        toast(`Status: ${label(r.monitor.status)}`);
        reload();
      }, { kind: "ghost", iconName: "refresh" }),
      button("Edit", () => monitorDialog(m, reload), { kind: "ghost" }),
      button("Delete", async () => {
        if (!(await confirmDialog("Delete monitor", "Monitors with incident history are paused instead of deleted, to keep the record.", { danger: true, confirmLabel: "Delete" }))) return;
        const r = await api("DELETE", `/api/monitors/${m.id}`);
        toast(r.message || "Monitor deleted.");
        location.hash = "#/monitoring";
      }, { kind: "ghost danger-text" }),
    ] : []),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Status"), h("span", { class: "stat-value" }, badge(m.status))),
      h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Uptime 24 h"), h("span", { class: "stat-value" }, uptimeText(data.day.uptimePercent)), h("span", { class: "stat-hint" }, `${data.day.checks} checks`)),
      h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Uptime 7 days"), h("span", { class: "stat-value" }, uptimeText(data.week.uptimePercent))),
      h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Uptime 30 days"), h("span", { class: "stat-value" }, uptimeText(data.month.uptimePercent))),
      h("div", { class: "stat" }, h("span", { class: "stat-label" }, "Average response 24 h"), h("span", { class: "stat-value" }, data.day.avgResponseMs ? `${data.day.avgResponseMs} ms` : "—"))),
    card("Last 100 checks", data.checks.length ? bars : empty("No checks yet", "The first check runs within a minute of creating the monitor.")),
    card("Check log", data.checks.length ? h("div", { class: "table-scroll" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Time"), h("th", {}, "Result"), h("th", {}, "Response"), h("th", {}, "HTTP"), h("th", {}, "Error"))),
      h("tbody", {}, data.checks.slice(0, 30).map((c) => h("tr", {}, h("td", {}, fmtDateTime(c.checkedAt)), h("td", {}, badge(c.ok ? "up" : "down")), h("td", {}, c.responseMs ? `${c.responseMs} ms` : "—"), h("td", {}, c.statusCode ?? "—"), h("td", {}, c.error || "")))))) : null),
    staff ? card("Settings", definitionList([["Interval", `${m.intervalSeconds} s`], ["Timeout", `${m.timeoutMs} ms`], ["Failures before incident", m.failureThreshold], ["Healthy status", m.expectedStatus], ["Visible to customer", m.customerVisible ? "Yes" : "No"], ["Last error", m.lastError]])) : null);
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
    ])));
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
    const allUp = monitors.items.length && monitors.items.every((m) => m.status === "up");
    clear(main, pageHeader("Service status", "What OSVIA is monitoring for your organization."),
      open.length ? h("div", { class: "banner bad" }, h("strong", {}, `${open.length} ongoing incident(s). `), "OSVIA is working on it.")
        : monitors.items.length ? h("div", { class: `banner ${allUp ? "ok" : "warn"}` }, allUp ? "All monitored services are responding." : "Some services have not reported a recent successful check.") : null,
      windows.items.map((w) => h("div", { class: "banner info" }, h("strong", {}, `Planned maintenance: ${w.title}`), ` ${fmtDateTime(w.startsAt)} to ${fmtDateTime(w.endsAt)}`)),
      card("Monitored services", monitors.items.length ? h("ul", { class: "mini-list" }, monitors.items.map((m) => h("li", {}, h("a", { href: `#/monitoring/${m.id}` }, h("span", { class: "grow" }, m.name), h("small", { class: "muted" }, `24 h uptime ${uptimeText(m.uptimePercent)}`), badge(m.status))))) : empty("Nothing monitored yet", "Ask OSVIA to monitor your website, internet link or servers.")),
      card("Recent incidents", incidents.items.length ? h("ul", { class: "mini-list" }, incidents.items.map((i) => h("li", {}, h("a", { href: `#/incidents/${i.id}` }, h("span", { class: "grow" }, i.title), h("small", { class: "muted" }, fmtDateTime(i.startedAt)), badge(i.status === "open" ? "down" : "resolved", i.status === "open" ? "Ongoing" : "Resolved"))))) : empty("No incidents")));
  } catch (error) {
    clear(main, pageHeader("Service status"), errorBox(error, () => statusPage(main)));
  }
}
