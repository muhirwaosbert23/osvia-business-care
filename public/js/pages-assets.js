import {
  api, ASSET_TYPES, badge, button, card, clear, CONDITIONS, confirmDialog, dataTable, definitionList, download, empty, enumOptions, errorBox, fmtDate,
  fmtDateTime, fmtRelative, formDialog, h, isRole, isStaff, label, OPERATIONAL, orgOptions, pageHeader, skeleton, staffOptions, state, toast,
} from "./core.js";

async function orgUsers(organizationId) {
  if (!organizationId) return [];
  if (isRole("customer_user")) return [];
  const data = await api("GET", `/api/users?limit=100${isStaff() ? `&organizationId=${organizationId}` : ""}`);
  return data.items.filter((u) => u.active).map((u) => [String(u.id), u.name]);
}

function reachability(d) {
  return h("span", { class: "inline-flex" }, badge(d.reachability), h("small", { class: "muted" }, d.source === "meshcentral" ? "agent" : d.lastChecked ? "check" : ""));
}

export function devicesPage(main, query) {
  const staff = isStaff();
  const canAdd = staff || isRole("customer_admin");
  const filters = [
    { name: "reachability", label: "Status", value: query.get("reachability") || "", options: [["", "Any status"], ["online", "Online"], ["offline", "Offline"], ["unknown", "Not checked"]] },
    { name: "assetType", label: "Type", value: "", options: enumOptions(ASSET_TYPES, "Any type") },
    { name: "warranty", label: "Warranty", value: "", options: [["", "Any warranty"], ["expiring", "Ends within 60 days"]] },
    { name: "archived", label: "Archived", value: "", options: [["", "In use"], ["1", "Archived"]] },
  ];
  const toolbar = [
    button("Export CSV", () => download(`/api/devices/export.csv?${new URLSearchParams(table.params)}`), { kind: "ghost", iconName: "download" }),
    staff ? button("Sync MeshCentral", async () => {
      const r = await api("POST", "/api/integrations/meshcentral/sync");
      if (r.status === "not_configured") toast("MeshCentral is not configured on this server.", "error");
      else if (r.status === "error") toast(`Sync finished with errors: ${(r.errors || []).slice(0, 1).join(" ")}`, "error");
      else toast(`MeshCentral sync: ${r.created} new, ${r.updated} updated.`);
      table.refresh();
    }, { kind: "ghost", iconName: "refresh" }) : null,
  ];
  const table = dataTable({
    columns: [
      { label: "Device", sort: "name", render: (d) => h("div", {}, h("strong", {}, d.name), h("small", { class: "muted block" }, [staff ? d.organizationName : null, d.assetTag ? `Tag ${d.assetTag}` : null].filter(Boolean).join(" · "))) },
      { label: "Type", render: (d) => label(d.assetType) },
      { label: "Assigned to", render: (d) => d.assignedUserName || h("span", { class: "muted" }, "—") },
      { label: "Status", sort: "status", render: reachability },
      { label: "Last checked", sort: "checked", render: (d) => (d.lastChecked ? fmtRelative(d.lastChecked) : "—") },
      { label: "Warranty", sort: "warranty", render: (d) => (d.warrantyExpiry ? h("span", { class: d.warrantyExpiry < new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10) ? "text-warn" : "" }, fmtDate(d.warrantyExpiry)) : "—") },
      { label: "Remote consent", render: (d) => (d.consentAt ? badge("ok", "Given") : badge("muted", "Not given")) },
    ],
    filters,
    toolbar,
    defaultSort: { key: "name", dir: "asc" },
    searchPlaceholder: "Name, serial, tag or model",
    load: (q) => api("GET", `/api/devices?${q}`),
    rowHref: (d) => `#/devices/${d.id}`,
    emptyText: "No devices yet. Add the computers and equipment OSVIA looks after.",
  });
  clear(main, pageHeader(isRole("customer_user") ? "My devices" : "Devices and assets", "Status shows the most recent verified check. Devices that were never checked show Unknown.", canAdd ? [button("Add device", () => deviceDialog(null, () => table.refresh()), { kind: "primary", iconName: "plus" })] : []), table.el);
}

async function deviceDialog(device, onDone) {
  const staff = isStaff();
  const orgId = device?.organizationId || state.me.organizationId;
  const fields = [];
  if (staff && !device) fields.push({ name: "organizationId", label: "Organization", type: "select", required: true, options: await orgOptions() });
  fields.push(
    { name: "name", label: "Device name", required: true, max: 120, value: device?.name, placeholder: "e.g. RECEPTION-PC" },
    { name: "assetType", label: "Type", type: "select", options: enumOptions(ASSET_TYPES), value: device?.assetType || "computer" },
    { name: "manufacturer", label: "Manufacturer", max: 120, value: device?.manufacturer },
    { name: "model", label: "Model", max: 120, value: device?.model },
    { name: "serialNumber", label: "Serial number", max: 120, value: device?.serialNumber },
    { name: "assetTag", label: "Asset tag", max: 60, value: device?.assetTag, help: "Unique within the organization." },
    { name: "operatingSystem", label: "Operating system", max: 120, value: device?.operatingSystem },
  );
  const users = device || !staff ? await orgUsers(orgId) : [];
  if (users.length) fields.push({ name: "assignedUserId", label: "Assigned to", type: "select", options: [["", "Nobody"], ...users], value: device?.assignedUserId ? String(device.assignedUserId) : "" });
  fields.push(
    { name: "installDate", label: "Install date", type: "date", value: device?.installDate },
    { name: "warrantyExpiry", label: "Warranty expiry", type: "date", value: device?.warrantyExpiry },
    { name: "condition", label: "Condition", type: "select", options: enumOptions(CONDITIONS), value: device?.condition || "unknown" },
    { name: "operationalStatus", label: "In use", type: "select", options: enumOptions(OPERATIONAL), value: device?.operationalStatus || "in_service" },
    { name: "hardwareNotes", label: "Hardware notes", type: "textarea", rows: 2, max: 2000, value: device?.hardwareNotes, full: true, help: "RAM, disk, peripherals. Never store passwords here." },
    { name: "notes", label: "Notes", type: "textarea", rows: 2, max: 2000, value: device?.notes, full: true },
  );
  if (staff) {
    fields.push(
      { type: "heading", label: "Status check (OSVIA staff only)" },
      { name: "address", label: "IP address or host name", max: 253, value: device?.address, help: "Reachable from the OSVIA server. Leave empty if MeshCentral reports status." },
      { name: "checkPort", label: "TCP port to check", type: "number", min: 1, maxValue: 65535, value: device?.checkPort ?? "", help: "Optional. Without a port, ping and port 445 are tried." },
    );
  }
  formDialog(device ? `Edit ${device.name}` : "Add device", fields, async (values, close) => {
    const body = { ...values };
    if (body.organizationId) body.organizationId = Number(body.organizationId);
    if ("assignedUserId" in body) body.assignedUserId = body.assignedUserId ? Number(body.assignedUserId) : null;
    if (!staff) {
      delete body.address;
      delete body.checkPort;
    }
    const res = device ? await api("PATCH", `/api/devices/${device.id}`, body) : await api("POST", "/api/devices", body);
    close();
    toast(device ? "Device saved." : "Device added.");
    onDone?.(res.device);
  }, { wide: true, submitLabel: device ? "Save" : "Add device" });
}

export async function deviceDetailPage(main, id) {
  clear(main, skeleton(8));
  let data;
  try {
    data = await api("GET", `/api/devices/${id}`);
  } catch (error) {
    clear(main, pageHeader("Device"), errorBox(error, () => deviceDetailPage(main, id)));
    return;
  }
  const d = data.device;
  const staff = isStaff();
  const reload = () => deviceDetailPage(main, id);
  const actions = [];
  if ((staff || isRole("customer_admin")) && !d.archivedAt) actions.push(button("Edit", () => deviceDialog(d, reload), { kind: "ghost" }));
  if (staff && d.source !== "meshcentral" && d.address) actions.push(button("Check now", async () => {
    const r = await api("POST", `/api/devices/${d.id}/check`);
    toast(`${r.device.name} is ${label(r.device.reachability).toLowerCase()}.`);
    reload();
  }, { kind: "ghost", iconName: "refresh" }));
  if (staff && d.managed) actions.push(button("Remote session", () => remoteDialog(d), { kind: "primary", iconName: "remote", disabled: !d.consentAt, title: d.consentAt ? null : "The customer has not given consent" }));
  if (isRole("customer_admin") && !d.archivedAt) {
    actions.push(d.consentAt
      ? button("Withdraw remote consent", async () => {
        if (!(await confirmDialog("Withdraw consent", "OSVIA will no longer be able to start remote sessions on this device from the portal."))) return;
        await api("POST", `/api/devices/${d.id}/consent/revoke`);
        toast("Consent withdrawn.");
        reload();
      }, { kind: "ghost" })
      : button("Allow remote support", () => formDialog("Allow remote support", [
        { type: "note", label: "OSVIA technicians may connect to this device through MeshCentral to help you. Each session is recorded here with the technician and the reason, and you receive a notification. You can withdraw consent at any time." },
        { name: "confirm", label: "I am authorized to allow remote support on this device", type: "checkbox" },
      ], async (values, close) => {
        await api("POST", `/api/devices/${d.id}/consent`, { confirm: values.confirm });
        close();
        toast("Consent recorded.");
        reload();
      }, { submitLabel: "Record consent" }), { kind: "primary" }));
  }
  if ((staff || isRole("customer_admin")) && !d.archivedAt) actions.push(button("Archive", async () => {
    if (!(await confirmDialog("Archive device", `${d.name} will be marked retired and hidden from active lists. Its history is kept.`, { confirmLabel: "Archive", danger: true }))) return;
    await api("POST", `/api/devices/${d.id}/archive`);
    toast("Device archived.");
    reload();
  }, { kind: "ghost danger-text" }));

  clear(main,
    h("a", { href: "#/devices", class: "back" }, "← All devices"),
    pageHeader(d.name, [staff ? d.organizationName : null, label(d.assetType), d.archivedAt ? "Archived" : null].filter(Boolean).join(" · "), actions),
    h("div", { class: "detail" },
      h("div", { class: "detail-main" },
        card("Asset", definitionList([
          ["Manufacturer", d.manufacturer], ["Model", d.model], ["Serial number", d.serialNumber], ["Asset tag", d.assetTag],
          ["Operating system", d.operatingSystem], ["Assigned to", d.assignedUserName], ["Install date", fmtDate(d.installDate)],
          ["Warranty expiry", fmtDate(d.warrantyExpiry)], ["Condition", label(d.condition)], ["In use", label(d.operationalStatus)],
          ["Hardware notes", d.hardwareNotes ? h("span", { class: "pre" }, d.hardwareNotes) : null], ["Notes", d.notes ? h("span", { class: "pre" }, d.notes) : null],
        ])),
        card("Support tickets", data.tickets.length ? h("ul", { class: "mini-list" }, data.tickets.map((t) => h("li", {}, h("a", { href: `#/tickets/${t.id}` }, h("span", { class: "mono" }, t.number), h("span", { class: "grow" }, t.title), badge(t.status))))) : empty("No tickets for this device")),
        card("Maintenance history", data.maintenance.length ? h("ul", { class: "mini-list" }, data.maintenance.map((m) => h("li", {}, h("span", { class: "muted" }, fmtDate(m.performedAt)), h("span", { class: "grow" }, m.summary), h("small", {}, m.technician)))) : empty("No maintenance recorded")),
        card("Assignment history", data.assignments.length ? h("ul", { class: "mini-list" }, data.assignments.map((a) => h("li", {}, h("span", { class: "muted" }, fmtDateTime(a.createdAt)), h("span", { class: "grow" }, `${a.userName}${a.note ? ` · ${a.note}` : ""}`), h("small", {}, `by ${a.byName}`)))) : empty("Never assigned"))),
      h("aside", { class: "detail-side" },
        card("Status", definitionList([
          ["Reachability", badge(d.reachability)],
          ["Source", d.source === "meshcentral" ? "MeshCentral agent" : d.lastChecked ? "Network check from the OSVIA server" : "Not monitored"],
          ["Last checked", d.lastChecked ? `${fmtDateTime(d.lastChecked)} (${fmtRelative(d.lastChecked)})` : "Never"],
          ["Last seen online", fmtDateTime(d.lastConnection)],
          staff ? ["Check address", d.address ? `${d.address}${d.checkPort ? `:${d.checkPort}` : ""}` : null] : null,
          staff ? ["MeshCentral node", d.meshNodeId ? h("span", { class: "mono small" }, d.meshNodeId) : "Not linked"] : null,
          ["Remote consent", d.consentAt ? `Given ${fmtDateTime(d.consentAt)}` : "Not given"],
        ])),
        card("Remote sessions", data.remoteSessions.length ? h("ul", { class: "mini-list" }, data.remoteSessions.map((r) => h("li", { class: "col" }, h("strong", {}, `${r.technician} · ${label(r.mode)}`), h("small", { class: "muted" }, fmtDateTime(r.launchedAt)), h("span", { class: "small" }, r.reason)))) : empty("No remote sessions", "Every session started from the portal is listed here."), { cls: "subtle" }))));
}

async function remoteDialog(d) {
  const tickets = await api("GET", `/api/tickets?deviceId=${d.id}&status=active&limit=20`).catch(() => ({ items: [] }));
  formDialog(`Remote session on ${d.name}`, [
    { type: "note", label: "MeshCentral opens in a new tab and asks you to sign in with your own MeshCentral account. The customer is notified and the session is recorded with your reason." },
    { name: "mode", label: "Session type", type: "select", options: [["desktop", "Remote desktop"], ["terminal", "Terminal"], ["files", "Files"], ["general", "Device page"]] },
    { name: "ticketId", label: "Related ticket", type: "select", options: [["", "None"], ...tickets.items.map((t) => [String(t.id), `${t.number} ${t.title}`])] },
    { name: "reason", label: "Reason", required: true, max: 300, full: true, placeholder: "e.g. Installing the accounts printer driver" },
  ], async (values, close) => {
    const res = await api("POST", `/api/devices/${d.id}/remote`, { mode: values.mode, reason: values.reason, ticketId: values.ticketId ? Number(values.ticketId) : undefined });
    close();
    const win = window.open(res.url, "_blank", "noopener");
    if (!win) toast("Allow pop-ups for this site to open MeshCentral.", "error");
    else toast("Session recorded. MeshCentral opened in a new tab.");
  }, { submitLabel: "Start session" });
}

export function maintenancePage(main, query) {
  const staff = isStaff();
  const tab = query.get("tab") || "schedules";
  const tabs = h("nav", { class: "tabs" },
    h("a", { href: "#/maintenance", class: tab === "schedules" ? "active" : "" }, "Planned"),
    h("a", { href: "#/maintenance?tab=records", class: tab === "records" ? "active" : "" }, "Completed work"));
  const actions = [button("Download report", () => reportDialog(), { kind: "ghost", iconName: "download" })];
  if (staff) {
    actions.push(button("Record work", () => recordDialog(() => table.refresh()), { kind: "ghost", iconName: "plus" }));
    actions.push(button("Plan maintenance", () => scheduleDialog(null, () => table.refresh()), { kind: "primary", iconName: "calendar" }));
  }
  let table;
  if (tab === "records") {
    table = dataTable({
      columns: [
        { label: "Date", render: (m) => fmtDate(m.performedAt) },
        staff ? { label: "Organization", key: "organizationName" } : null,
        { label: "Device", render: (m) => m.deviceName || "General" },
        { label: "Work performed", render: (m) => h("span", { class: "pre" }, m.summary) },
        { label: "Technician", key: "technician" },
        staff ? { label: "Time", render: (m) => (m.minutesSpent ? `${m.minutesSpent} min` : "—") } : null,
      ].filter(Boolean),
      searchPlaceholder: null,
      load: (q) => api("GET", `/api/maintenance/records?${q}`),
      emptyText: "No maintenance has been recorded yet.",
    });
  } else {
    table = dataTable({
      columns: [
        { label: "Task", sort: "title", render: (s) => h("div", {}, h("strong", {}, s.title), s.notes ? h("small", { class: "muted block" }, s.notes) : null) },
        staff ? { label: "Organization", key: "organizationName" } : null,
        { label: "Device", render: (s) => s.deviceName || "—" },
        { label: "Due", sort: "due", render: (s) => (s.overdue ? badge("breached", `Overdue · ${fmtDate(s.nextDue)}`) : fmtDate(s.nextDue)) },
        { label: "Repeats", render: (s) => (s.intervalDays ? `Every ${s.intervalDays} days` : "Once") },
        { label: "Technician", render: (s) => s.assigneeName || "—" },
        staff ? { label: "", render: (s) => h("div", { class: "row-actions" },
          button("Complete", () => completeDialog(s, () => table.refresh()), { kind: "small primary" }),
          button("Edit", () => scheduleDialog(s, () => table.refresh()), { kind: "small ghost" })) } : null,
      ].filter(Boolean),
      filters: staff ? [{ name: "overdue", label: "Due", value: query.get("overdue") || "", options: [["", "All planned"], ["1", "Overdue only"]] }, { name: "assigned", label: "Technician", value: "", options: [["", "Anyone"], ["me", "Assigned to me"]] }] : [],
      defaultSort: { key: "due", dir: "asc" },
      searchPlaceholder: null,
      load: (q) => api("GET", `/api/maintenance/schedules?${q}`),
      emptyText: "No maintenance is planned.",
    });
  }
  clear(main, pageHeader("Preventive maintenance", "Planned care for computers and equipment, and a record of the work done.", actions), tabs, table.el);
}

async function deviceOptions(organizationId) {
  if (!organizationId) return [];
  const data = await api("GET", `/api/devices?limit=100&sort=name&dir=asc${isStaff() ? `&organizationId=${organizationId}` : ""}`);
  return data.items.map((d) => [String(d.id), d.name]);
}

async function pickOrg(title, next) {
  formDialog(title, [{ name: "organizationId", label: "Organization", type: "select", required: true, options: await orgOptions() }], async (values, close) => {
    close();
    await next(Number(values.organizationId));
  }, { submitLabel: "Continue" });
}

async function scheduleDialog(schedule, onDone) {
  const open = async (organizationId) => {
    const [devices, staffList] = await Promise.all([deviceOptions(organizationId), staffOptions()]);
    formDialog(schedule ? "Edit planned maintenance" : "Plan maintenance", [
      { name: "title", label: "Task", required: true, max: 160, value: schedule?.title, placeholder: "e.g. Quarterly antivirus and updates review" },
      { name: "nextDue", label: "Due date", type: "date", required: true, value: schedule?.nextDue },
      { name: "intervalDays", label: "Repeat every (days)", type: "number", min: 1, maxValue: 3650, value: schedule?.intervalDays ?? "", help: "Leave empty for a one-off task." },
      { name: "deviceId", label: "Device", type: "select", options: [["", "Whole organization"], ...devices], value: schedule?.deviceId ? String(schedule.deviceId) : "" },
      { name: "assignedTo", label: "Technician", type: "select", options: [["", "Unassigned"], ...staffList], value: schedule?.assignedTo ? String(schedule.assignedTo) : "" },
      { name: "notes", label: "Notes", type: "textarea", rows: 2, max: 2000, value: schedule?.notes, full: true },
      schedule ? { name: "active", label: "Active", type: "checkbox", value: schedule.active } : null,
    ].filter(Boolean), async (values, close) => {
      const body = { ...values, intervalDays: values.intervalDays || null, deviceId: values.deviceId ? Number(values.deviceId) : null, assignedTo: values.assignedTo ? Number(values.assignedTo) : null };
      if (schedule) await api("PATCH", `/api/maintenance/schedules/${schedule.id}`, body);
      else await api("POST", "/api/maintenance/schedules", { ...body, organizationId });
      close();
      toast("Saved.");
      onDone?.();
    }, { wide: true });
  };
  if (schedule) open(schedule.organizationId);
  else pickOrg("Plan maintenance for", open);
}

function completeDialog(schedule, onDone) {
  formDialog(`Complete: ${schedule.title}`, [
    { name: "summary", label: "Work performed", type: "textarea", required: true, max: 4000, full: true, help: "The customer's administrators see this." },
    { name: "performedAt", label: "Date performed", type: "date", value: new Date().toISOString().slice(0, 10) },
    { name: "minutesSpent", label: "Time spent (minutes)", type: "number", min: 1, maxValue: 1440 },
  ], async (values, close) => {
    await api("POST", `/api/maintenance/schedules/${schedule.id}/complete`, { ...values, minutesSpent: values.minutesSpent || undefined });
    close();
    toast(schedule.intervalDays ? "Completed. The next date was scheduled." : "Completed.");
    onDone?.();
  }, { submitLabel: "Mark complete" });
}

function recordDialog(onDone) {
  pickOrg("Record work for", async (organizationId) => {
    const devices = await deviceOptions(organizationId);
    formDialog("Record maintenance work", [
      { name: "deviceId", label: "Device", type: "select", options: [["", "General"], ...devices] },
      { name: "summary", label: "Work performed", type: "textarea", required: true, max: 4000, full: true },
      { name: "performedAt", label: "Date performed", type: "date", required: true, value: new Date().toISOString().slice(0, 10) },
      { name: "minutesSpent", label: "Time spent (minutes)", type: "number", min: 1, maxValue: 1440 },
    ], async (values, close) => {
      await api("POST", "/api/maintenance/records", { ...values, organizationId, deviceId: values.deviceId ? Number(values.deviceId) : null, minutesSpent: values.minutesSpent || undefined });
      close();
      toast("Work recorded.");
      onDone?.();
    }, { wide: true });
  });
}

async function reportDialog() {
  const today = new Date().toISOString().slice(0, 10);
  const fields = [];
  if (isStaff()) fields.push({ name: "organizationId", label: "Organization", type: "select", required: true, options: await orgOptions() });
  fields.push({ name: "from", label: "From", type: "date", required: true, value: `${today.slice(0, 7)}-01` }, { name: "to", label: "To", type: "date", required: true, value: today });
  formDialog("Maintenance report (PDF)", fields, async (values, close) => {
    await download(`/api/maintenance/report.pdf?${new URLSearchParams(Object.entries(values).filter(([, v]) => v))}`);
    close();
  }, { submitLabel: "Download" });
}
