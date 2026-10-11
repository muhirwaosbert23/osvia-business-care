import {
  api, ASSET_TYPES, badge, button, card, clear, CONDITIONS, copyLinkButton, currentQuery, dataTable, definitionList, dialog, download, empty, enumOptions, errorBox, fmtDate,
  fmtDateTime, fmtRelative, formDialog, h, isRole, isStaff, label, OPERATIONAL, orgOptions, pageHeader, skeleton, staffOptions, state, toast,
} from "./core.js";
import { historyCard, withReason } from "./history.js";

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
    staff ? button("Map", () => { location.hash = "#/map"; }, { kind: "ghost", iconName: "map" }) : null,
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
      { label: "Device", sort: "name", render: (d) => h("div", {}, h("strong", {}, d.name, staff && d.hasLocation ? h("span", { class: "muted", title: "On the map" }, " · map") : null), h("small", { class: "muted block" }, [staff ? d.organizationName : null, d.assetTag ? `Tag ${d.assetTag}` : null].filter(Boolean).join(" · "))) },
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
      { name: "meshNodeId", label: "MeshCentral node id", max: 200, value: device?.meshNodeId, help: "Paste node//… from MeshCentral if this PC already has an agent. Leave empty and sync the organization group when MeshCentral is configured." },
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
  const actions = [copyLinkButton()];
  if ((staff || isRole("customer_admin")) && !d.archivedAt) actions.push(button("Edit", () => deviceDialog(d, reload), { kind: "ghost" }));
  if (staff && d.source !== "meshcentral" && d.address) actions.push(button("Check now", async () => {
    const r = await api("POST", `/api/devices/${d.id}/check`);
    toast(`${r.device.name} is ${label(r.device.reachability).toLowerCase()}.`);
    reload();
  }, { kind: "ghost", iconName: "refresh" }));
  if (staff && d.managed) actions.push(button("Remote session", () => remoteDialog(d), { kind: "primary", iconName: "remote", disabled: !d.consentAt, title: d.consentAt ? null : "The customer has not given consent" }));
  if (staff) actions.push(button("Remote desk", () => { location.hash = "#/remote"; }, { kind: "ghost", iconName: "monitor" }));
  if (isRole("customer_admin") && !d.archivedAt) {
    actions.push(d.consentAt
      ? button("Withdraw remote consent", () => withReason("Withdraw consent", "OSVIA will no longer be able to start remote sessions on this device from the portal.", async (reason) => {
        await api("POST", `/api/devices/${d.id}/consent/revoke`, { reason });
        toast("Consent withdrawn.");
        reload();
      }, { submitLabel: "Withdraw consent" }), { kind: "ghost" })
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
  if ((staff || isRole("customer_admin")) && !d.archivedAt) actions.push(button("Archive", () => withReason("Archive device", `${d.name} will be marked retired and hidden from active lists. Its history is kept.`, async (reason) => {
    await api("POST", `/api/devices/${d.id}/archive`, { reason });
    toast("Device archived.");
    reload();
  }, { submitLabel: "Archive", placeholder: "e.g. Replaced by a new laptop" }), { kind: "ghost danger-text" }));

  clear(main,
    h("a", { href: "#/devices", class: "back" }, "← All devices"),
    pageHeader(d.name, [staff ? d.organizationName : null, label(d.assetType), d.archivedAt ? "Archived" : null].filter(Boolean).join(" · "), actions),
    h("div", { class: "detail" },
      h("div", { class: "detail-main" },
        staff ? troubleshootCard(d, data, reload) : null,
        card("Asset", definitionList([
          ["Manufacturer", d.manufacturer], ["Model", d.model], ["Serial number", d.serialNumber], ["Asset tag", d.assetTag],
          ["Operating system", d.operatingSystem], ["Assigned to", d.assignedUserName], ["Install date", fmtDate(d.installDate)],
          ["Warranty expiry", fmtDate(d.warrantyExpiry)], ["Condition", label(d.condition)], ["In use", label(d.operationalStatus)],
          ["Hardware notes", d.hardwareNotes ? h("span", { class: "pre" }, d.hardwareNotes) : null], ["Notes", d.notes ? h("span", { class: "pre" }, d.notes) : null],
        ])),
        availabilityCard(d),
        staff ? locationCard(d, reload) : null,
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
        card("Remote sessions", data.remoteSessions.length ? h("ul", { class: "mini-list" }, data.remoteSessions.map((r) => h("li", { class: "col" }, h("strong", {}, `${r.technician} · ${label(r.mode)}`), h("small", { class: "muted" }, fmtDateTime(r.launchedAt)), h("span", { class: "small" }, r.reason)))) : empty("No remote sessions", "Every session started from the portal is listed here."), { cls: "subtle" }))),
    historyCard("device", d.id));
}

const SOURCE_TEXT = { meshcentral: "MeshCentral agent reports", network_check: "network checks from the OSVIA server", none: "no status source" };

function lasted(minutes) {
  if (minutes === null) return "until now";
  if (minutes < 60) return `lasted ${minutes} min`;
  if (minutes < 1440) return `lasted ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `lasted ${Math.floor(minutes / 1440)} d ${Math.floor((minutes % 1440) / 60)} h`;
}

export function uptimeBars(daily, { unit = "day" } = {}) {
  const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return h("div", { class: "uptime-bars", role: "img", "aria-label": `Daily availability, oldest first` }, daily.map((d) => {
    const pct = d.uptimePercent;
    const tone = pct === null ? "none" : pct >= 99 ? "ok" : pct >= 90 ? "warn" : "bad";
    const text = pct === null ? "no data" : `${pct}%${d.coveredHours !== undefined ? ` of ${d.coveredHours} h checked` : ""}`;
    return h("span", { class: `uptime-bar ${tone}`, title: `${dayFmt.format(new Date(`${d.day}T12:00:00Z`))}: ${text}`, "aria-label": `${d.day} ${unit}: ${text}` });
  }));
}

function availabilityCard(d) {
  const body = h("div", {}, skeleton(2));
  const range = h("div", { class: "seg-toggle", role: "group", "aria-label": "Period" });
  const load = async (days) => {
    for (const b of range.children) b.classList.toggle("active", Number(b.dataset.days) === days);
    try {
      const r = await api("GET", `/api/devices/${d.id}/availability?days=${days}`);
      if (r.source === "none" && !r.changes.length) {
        clear(body, empty("Not monitored", isStaff() ? "Add an IP address or host name, or link a MeshCentral agent, to start recording availability." : "Ask OSVIA to start monitoring this device."));
        return;
      }
      const tone = r.uptimePercent === null ? "" : r.uptimePercent >= 99 ? "ok" : r.uptimePercent >= 90 ? "warn" : "bad";
      clear(body,
        h("div", { class: "avail-head" },
          h("div", {}, h("span", { class: `avail-value ${tone}` }, r.uptimePercent === null ? "No data" : `${r.uptimePercent}%`), h("span", { class: "muted small block" }, `online during checked time · last ${r.days} days`)),
          h("div", { class: "muted small right" }, `Based on ${SOURCE_TEXT[r.source]}.`, h("br"), `${r.coveragePercent}% of the period had check results.`)),
        uptimeBars(r.daily),
        h("div", { class: "uptime-legend muted small" }, h("span", {}, h("i", { class: "uptime-bar ok" }), "99% or more"), h("span", {}, h("i", { class: "uptime-bar warn" }), "90–99%"), h("span", {}, h("i", { class: "uptime-bar bad" }), "below 90%"), h("span", {}, h("i", { class: "uptime-bar none" }), "no checks")),
        r.changes.length ? h("div", {}, h("h3", { class: "subhead" }, "Status changes"), h("ul", { class: "status-changes" }, r.changes.slice(0, 15).map((c) => h("li", {},
          badge(c.status, c.status === "online" ? "Came online" : "Went offline"),
          h("span", { class: "grow" }, fmtDateTime(c.at), h("small", { class: "muted" }, ` · ${lasted(c.lastedMinutes)}`)),
          h("small", { class: "muted" }, c.source === "meshcentral" ? "agent" : "check"))))) : h("p", { class: "muted small" }, "No status changes recorded yet."));
    } catch (error) {
      clear(body, errorBox(error, () => load(days)));
    }
  };
  for (const days of [7, 30, 90]) range.append(h("button", { type: "button", class: "seg-btn", dataset: { days: String(days) }, onclick: () => load(days) }, `${days} days`));
  load(30);
  return card("Availability", body, { actions: range });
}

const LOCATION_SOURCE = {
  manual: "Pinned by staff",
  gps: "On-site GPS",
  ip: "Approximate (public IP)",
  meshcentral: "MeshCentral agent GPS",
};

function mapsFrame(loc, title) {
  return h("iframe", { class: "gmap", src: loc.embedUrl, title: title || "Google Map", loading: "lazy", referrerpolicy: "origin", allow: "fullscreen" });
}

function pinDialog(d, onDone) {
  formDialog(`Pin ${d.name} on the map`, [
    { type: "note", label: "Use coordinates from Google Maps (right-click a place), or Search place / I'm here instead." },
    { name: "lat", label: "Latitude", required: true, placeholder: "0.3476" },
    { name: "lng", label: "Longitude", required: true, placeholder: "32.5825" },
    { name: "label", label: "Place name", max: 200, placeholder: "e.g. Industrial Area, Kampala" },
  ], async (values, close) => {
    await api("POST", `/api/devices/${d.id}/location`, { lat: Number(values.lat), lng: Number(values.lng), label: values.label, source: "manual" });
    close();
    toast("Pinned on Google Maps.");
    onDone?.();
  }, { submitLabel: "Save pin" });
}

function placeDialog(d, onDone) {
  formDialog("Search a place", [
    { type: "note", label: "This looks up a public place name and pins the device there. It is not GPS from the computer." },
    { name: "place", label: "Place or address", required: true, max: 200, placeholder: "e.g. Kampala or Plot 4, Industrial Area" },
  ], async (values, close) => {
    await api("POST", `/api/devices/${d.id}/locate`, { place: values.place });
    close();
    toast("Place saved on the map.");
    onDone?.();
  }, { submitLabel: "Find and pin" });
}

async function locateFromIp(d, onDone) {
  const r = await api("POST", `/api/devices/${d.id}/locate`, {});
  toast(r.notice || "Public-IP area saved on the map.");
  onDone?.();
}

function hereNow(d, onDone) {
  if (!navigator.geolocation) {
    toast("This browser cannot share a location.", "error");
    return;
  }
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      await api("POST", `/api/devices/${d.id}/location`, {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        source: "gps",
        accuracyM: Math.round(pos.coords.accuracy || 30),
        label: "On-site",
      });
      toast("Saved your current position.");
      onDone?.();
    } catch (error) {
      toast(error.message, "error");
    }
  }, () => toast("Location permission was denied or unavailable.", "error"), { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
}

function locationCard(d, reload) {
  const body = h("div", { class: "loc-body" }, skeleton(2));
  const load = async () => {
    try {
      const r = await api("GET", `/api/devices/${d.id}/location`);
      const loc = r.location;
      const actions = h("div", { class: "row-actions wrap" },
        button("Pin on map", () => pinDialog(d, reload), { kind: "ghost small" }),
        button("Search place", () => placeDialog(d, reload), { kind: "ghost small" }),
        button("Find public IP", () => locateFromIp(d, reload), { kind: "ghost small" }),
        button("I'm here", () => hereNow(d, reload), { kind: "ghost small" }),
        loc?.mapsUrl ? h("a", { class: "btn small primary", href: loc.mapsUrl, target: "_blank", rel: "noopener" }, "Open in Google Maps") : null,
        r.pathUrl ? h("a", { class: "btn small ghost", href: r.pathUrl, target: "_blank", rel: "noopener" }, "Movement path") : null);
      if (!loc) {
        clear(body, h("p", { class: "muted" }, "No map position yet. Detect devices on the Map page to read MeshCentral GPS or a public IP. A typical office PC does not send GPS."), actions);
        return;
      }
      clear(body,
        mapsFrame(loc, `Google Map of ${d.name}`),
        h("p", { class: "muted small" }, `${LOCATION_SOURCE[loc.source] || loc.source}${loc.label ? ` · ${loc.label}` : ""} · ${fmtDateTime(loc.at)}${loc.source === "ip" ? ". City-level only — not the room the computer sits in." : ""}`),
        actions,
        r.items.length ? h("ul", { class: "mini-list loc-hist" }, r.items.map((e) => h("li", {},
          h("a", { href: e.mapsUrl, target: "_blank", rel: "noopener" }, e.label || `${e.lat}, ${e.lng}`),
          h("small", { class: "muted" }, `${LOCATION_SOURCE[e.source] || e.source} · ${fmtRelative(e.at)} · ${e.actorName}`)))) : null);
    } catch (error) {
      clear(body, errorBox(error, load));
    }
  };
  load();
  return card("Location on Google Maps", body);
}

function renderFleet(main, data) {
  const mapHost = h("div", { class: "fleet-map" });
  const list = h("ul", { class: "fleet-list" });
  const show = (item) => {
    for (const li of list.children) li.classList.toggle("active", Number(li.dataset.id) === item.id);
    const loc = item.location;
    clear(mapHost,
      mapsFrame(loc, `Google Map of ${item.name}`),
      h("div", { class: "fleet-meta" },
        h("div", {}, h("strong", {}, item.name), h("small", { class: "muted block" }, item.organizationName),
          h("small", { class: "muted block" }, `${LOCATION_SOURCE[loc.source] || loc.source} · ${fmtDateTime(loc.at)}${loc.label ? ` · ${loc.label}` : ""}`)),
        h("div", { class: "row-actions" },
          h("a", { class: "btn small primary", href: loc.mapsUrl, target: "_blank", rel: "noopener" }, "Open in Google Maps"),
          h("a", { class: "btn small ghost", href: `#/devices/${item.id}` }, "Device"))));
  };
  for (const item of data.items) {
    list.append(h("li", { dataset: { id: String(item.id) }, onclick: () => show(item) },
      h("strong", {}, item.name), badge(item.reachability),
      h("small", { class: "muted block" }, item.organizationName),
      h("small", { class: "muted block" }, item.location.label || `${item.location.lat}, ${item.location.lng}`)));
  }
  const missing = (data.missing || []).length
    ? h("div", { class: "muted small" }, `${data.missing.length} device(s) have no public position yet. MeshCentral GPS, a public IP, or a staff pin is required — a private office address cannot appear on Google Maps.`)
    : null;
  const waiting = (data.missing || []).length
    ? h("ul", { class: "mini-list" }, data.missing.slice(0, 12).map((item) => h("li", {},
      h("a", { href: `#/devices/${item.id}` }, item.name), badge(item.reachability),
      h("small", { class: "muted" }, item.organizationName))))
    : null;
  clear(main,
    pageHeader("Device map", "Press a device to see it on Google Maps. Positions come from MeshCentral agent GPS first, then the agent's public IP, then a staff pin.", [
      button("Detect devices", () => mapPage(main, { force: true }), { kind: "primary", iconName: "refresh" }),
    ]),
    data.items.length
      ? h("div", { class: "fleet" }, h("aside", { class: "fleet-side" }, list), mapHost)
      : empty("Nothing on the map yet", "Detect devices to read MeshCentral coordinates and public IPs. Typical office PCs have no GPS."),
    missing, waiting);
  if (data.items[0]) show(data.items[0]);
}

export async function mapPage(main, { force = false } = {}) {
  clear(main, skeleton(6));
  try {
    let data = await api("GET", "/api/devices/map");
    if (force || !data.items.length) {
      data = await api("POST", "/api/devices/map/refresh");
      const placed = (data.mesh?.located || 0) + (data.detected?.located || 0);
      if (placed) toast(`${placed} device(s) placed on the map.`);
      else if (!data.items.length) toast("No MeshCentral GPS or public IP was available to place.", "error");
    }
    renderFleet(main, data);
  } catch (error) {
    clear(main, pageHeader("Device map"), errorBox(error, () => mapPage(main, { force: true })));
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied. Paste it in the MeshCentral terminal.");
  } catch {
    toast("Copy failed. Select the command and copy it yourself.", "error");
  }
}

function openMeshSession(url, mode) {
  dialog("Open MeshCentral", [
    h("p", {}, "The session is recorded. Press the button to open it — this click is not blocked as a pop-up."),
    h("p", { class: "muted small" }, "If MeshCentral asks you to sign in, do that once and tick Remember this device so the next session goes straight through."),
  ], {
    actions: [
      (close) => h("a", { class: "btn primary", href: url, target: "_blank", rel: "noopener", onclick: () => close() }, `Open ${label(mode)}`),
    ],
  });
}

async function launchRemote(d, mode, reason) {
  const win = window.open("about:blank", "_blank");
  try {
    const res = await api("POST", `/api/devices/${d.id}/remote`, { mode, reason });
    if (win && !win.closed) {
      win.location.replace(res.url);
      toast("Session recorded. If MeshCentral asks you to sign in, tick Remember this device.");
      return;
    }
    openMeshSession(res.url, mode);
  } catch (error) {
    if (win && !win.closed) win.close();
    throw error;
  }
}

const FINDING_LABEL = { finding: "Finding", next_step: "Next step", note: "Note" };

function findingDialog(d, onDone) {
  formDialog(`Record note on ${d.name}`, [
    { name: "kind", label: "Type", type: "select", options: [["finding", "What we found"], ["next_step", "Next step"], ["note", "Note"]] },
    { name: "body", label: "Details", type: "textarea", required: true, max: 2000, full: true, help: "Never store passwords. The history keeps who wrote this." },
  ], async (values, close) => {
    await api("POST", `/api/devices/${d.id}/findings`, values);
    close();
    toast("Note saved.");
    onDone?.();
  }, { submitLabel: "Save note" });
}

function diagnoseView(result) {
  if (!result) return null;
  return h("div", { class: "diag" },
    h("p", { class: "muted small" }, result.notice),
    h("div", { class: "diag-grid" },
      h("div", { class: `diag-item ${result.dns.ok ? "ok" : "bad"}` }, h("strong", {}, "DNS"), h("span", {}, result.dns.ok ? result.dns.address : (result.dns.error || "Failed"))),
      h("div", { class: `diag-item ${result.ping.ok ? "ok" : "bad"}` }, h("strong", {}, "Ping"), h("span", {}, result.ping.ok ? "Replies" : "No reply")),
      ...result.ports.map((p) => h("div", { class: `diag-item ${p.open ? "ok" : "bad"}` }, h("strong", {}, p.name), h("span", {}, p.open ? `Open · ${p.port}` : `Closed · ${p.port}`)))));
}

function troubleshootCard(d, data, reload) {
  const pack = data.troubleshoot || { commands: [], playbooks: [], blockers: [] };
  const diagHost = h("div");
  const remoteReady = pack.canRemote;
  const actions = h("div", { class: "row-actions wrap" },
    button("Diagnose from OSVIA", async () => {
      const result = await api("POST", `/api/devices/${d.id}/diagnose`);
      clear(diagHost, diagnoseView(result));
      toast(result.ping.ok ? "The OSVIA server can reach this address." : "The OSVIA server cannot reach this address.");
    }, { kind: "primary small", iconName: "pulse", disabled: !pack.canDiagnose, title: pack.canDiagnose ? null : "Add an address or sync MeshCentral first" }),
    button("Desktop", () => launchRemote(d, "desktop", "Remote troubleshooting — desktop"), { kind: "small", iconName: "remote", disabled: !remoteReady }),
    button("Terminal", () => launchRemote(d, "terminal", "Remote troubleshooting — terminal"), { kind: "small", disabled: !remoteReady }),
    button("Files", () => launchRemote(d, "files", "Remote troubleshooting — files"), { kind: "small", disabled: !remoteReady }),
    button("Record note", () => findingDialog(d, reload), { kind: "ghost small" }),
  );
  const blockers = pack.blockers?.length ? h("ul", { class: "checklist" }, pack.blockers.map((text) => h("li", {}, h("span", { class: "tick" }, "!"), text))) : null;
  const books = h("div", { class: "playbooks" }, (pack.playbooks || []).map((book) => h("details", { class: "playbook" },
    h("summary", {}, book.title, book.available ? h("span", { class: "muted small" }, " · ready") : null),
    h("p", { class: "muted small" }, book.when),
    h("ol", {}, book.steps.map((step) => h("li", {}, step))),
    book.mode && remoteReady ? button(`Open ${label(book.mode)}`, () => launchRemote(d, book.mode, `Troubleshooting: ${book.title}`), { kind: "small primary" }) : null)));
  const commands = h("div", { class: "cmd-list" },
    h("p", { class: "muted small" }, "Paste these in a MeshCentral terminal. They read the computer; they are not run from this portal."),
    (pack.commands || []).map((item) => h("div", { class: "cmd" },
      h("div", {}, h("strong", {}, item.title), h("code", {}, item.command)),
      button("Copy", () => copyText(item.command), { kind: "ghost small" }))));
  const notes = (data.findings || []).length
    ? h("ul", { class: "mini-list" }, data.findings.map((f) => h("li", { class: "col" },
      h("strong", {}, `${FINDING_LABEL[f.kind] || f.kind} · ${f.actorName}`),
      h("small", { class: "muted" }, fmtDateTime(f.at)),
      h("span", { class: "pre" }, f.body))))
    : h("p", { class: "muted small" }, "No troubleshooting notes yet.");
  return card("Remote troubleshooting", [actions, blockers, diagHost, books, commands, notes], { cls: "trouble-card" });
}

function linkAgentDialog(item, onDone) {
  formDialog(`Link MeshCentral agent · ${item.name}`, [
    { type: "note", label: "Copy the node id from MeshCentral (it looks like node//abc123). This does not invent a connection — the agent must already exist." },
    { name: "meshNodeId", label: "MeshCentral node id", required: true, max: 200, placeholder: "node//…" },
  ], async (values, close) => {
    await api("PATCH", `/api/devices/${item.id}`, { meshNodeId: values.meshNodeId, reason: "Linked MeshCentral agent from Remote desk" });
    close();
    toast("Agent id saved. Open Desktop after MeshCentral is configured and the customer has given consent.");
    onDone?.();
  }, { submitLabel: "Save node id" });
}

function deskBanner(data) {
  if (data.meshConfigured && data.ready) {
    return h("div", { class: "banner ok" },
      h("strong", {}, "Ready to connect."),
      h("p", { class: "small" }, "Press Desktop, Terminal or Files. Sign in to MeshCentral once and tick Remember this device. After that, those buttons open the session directly."));
  }
  if (!data.meshConfigured) {
    return h("div", { class: "banner warn" },
      h("div", {},
        h("strong", {}, "MeshCentral is not configured on this server."),
        h("p", { class: "small" }, "Desktop, terminal and files need MeshCentral. Your devices still appear below. You can diagnose from the OSVIA server, check reachability, and record notes now."),
        h("ol", { class: "desk-steps" },
          h("li", {}, "On the server, set ", h("code", {}, "MESHCENTRAL_URL"), ", ", h("code", {}, "MESHCTRL_PATH"), ", ", h("code", {}, "MESHCENTRAL_USER"), " and a login key file, then restart the portal."),
          h("li", {}, "Open the organization and save the MeshCentral device group id (for example ", h("code", {}, "mesh//…"), ")."),
          h("li", {}, "Press Sync MeshCentral. Agents appear here. The customer must allow remote support — you already have consent on some devices."),
          h("li", {}, "Then Desktop, Terminal and Files open in a new tab and are recorded.")),
        h("div", { class: "row-actions wrap" },
          h("a", { class: "btn small", href: "#/settings?tab=system" }, "Settings"),
          h("a", { class: "btn small ghost", href: "#/organizations" }, "Organizations"))));
  }
  if (data.needAgent) {
    return h("div", { class: "banner info" },
      h("strong", {}, `${data.needAgent} device(s) still need the MeshCentral agent.`),
      h("p", { class: "small" }, "On that computer open MeshCentral, install the Windows agent for the customer's group, then press Sync MeshCentral here."),
      data.meshUrl ? h("a", { class: "btn small", href: data.meshUrl, target: "_blank", rel: "noopener" }, "Open MeshCentral") : null);
  }
  return null;
}

export async function remoteDeskPage(main, query = currentQuery()) {
  clear(main, skeleton(6));
  let data;
  try {
    data = await api("GET", "/api/devices/remote");
  } catch (error) {
    clear(main, pageHeader("Remote desk"), errorBox(error, () => remoteDeskPage(main, query)));
    return;
  }
  const filter = query.get("view") || "all";
  const views = [
    ["all", "All", data.total],
    ["ready", "Ready", data.ready],
    ["agent", "Need agent", data.needAgent],
    ["consent", "Need consent", data.needConsent],
    ["diagnose", "Can diagnose", data.canDiagnose],
  ];
  const shown = data.items.filter((item) => {
    if (filter === "ready") return item.ready;
    if (filter === "agent") return !item.managed;
    if (filter === "consent") return item.managed && !item.consent;
    if (filter === "diagnose") return item.canDiagnose;
    return true;
  });
  const diagHost = h("div");
  const reload = () => remoteDeskPage(main, currentQuery());
  const rowActions = (item) => h("div", { class: "row-actions wrap" },
    button("Diagnose", async () => {
      const result = await api("POST", `/api/devices/${item.id}/diagnose`);
      clear(diagHost, card(item.name, diagnoseView(result)));
      toast(result.ping.ok ? `${item.name}: the OSVIA server can reach it.` : `${item.name}: the OSVIA server cannot reach it.`);
    }, { kind: "small", iconName: "pulse", disabled: !item.canDiagnose }),
    item.canCheck ? button("Check now", async () => {
      const r = await api("POST", `/api/devices/${item.id}/check`);
      toast(`${item.name} is ${label(r.device.reachability).toLowerCase()}.`);
      reload();
    }, { kind: "small ghost", iconName: "refresh" }) : null,
    button("Desktop", () => launchRemote(item, "desktop", "Remote desk — desktop"), { kind: "small primary", iconName: "remote", disabled: !item.ready, title: item.ready ? null : item.nextStep }),
    button("Terminal", () => launchRemote(item, "terminal", "Remote desk — terminal"), { kind: "small", disabled: !item.ready }),
    button("Files", () => launchRemote(item, "files", "Remote desk — files"), { kind: "small", disabled: !item.ready }),
    button("Link agent", () => linkAgentDialog(item, reload), { kind: "ghost small" }),
    h("a", { class: "btn small ghost", href: `#/devices/${item.id}` }, "Troubleshoot"));
  const table = h("div", { class: "table-card" }, h("table", { class: "table" },
    h("thead", {}, h("tr", {}, ["Device", "Organization", "Status", "Next step", ""].map((t) => h("th", {}, t)))),
    h("tbody", {}, shown.length ? shown.map((item) => h("tr", {},
      h("td", { "data-label": "Device" }, h("a", { href: `#/devices/${item.id}` }, h("strong", {}, item.name)), h("small", { class: "muted block" }, [item.operatingSystem || "OS unknown", item.address].filter(Boolean).join(" · "))),
      h("td", { "data-label": "Organization" }, item.organizationName),
      h("td", { "data-label": "Status" }, badge(item.reachability), item.consent ? badge("ok", "Consent") : badge("muted", "No consent"), item.managed ? badge("info", "Agent") : badge("muted", "No agent")),
      h("td", { "data-label": "Next step" }, item.ready ? badge("ok", "Ready") : badge("warn", item.blocked || "Not ready"), h("small", { class: "muted block" }, item.nextStep)),
      h("td", { "data-label": "" }, rowActions(item)))) : h("tr", {}, h("td", { colspan: "5" }, empty("No devices in this view", "Add a device under Devices, or choose All."))))));
  const stats = h("div", { class: "desk-stats" },
    [["Devices", data.total], ["Ready for MeshCentral", data.ready], ["Need agent", data.needAgent], ["Need consent", data.needConsent], ["Can diagnose", data.canDiagnose]].map(([title, value]) => h("div", { class: "stat" }, h("span", { class: "stat-label" }, title), h("span", { class: "stat-value" }, value))));
  const tabs = h("nav", { class: "tabs" }, views.map(([key, title, count]) => h("a", { href: `#/remote?view=${key}`, class: filter === key ? "active" : "" }, `${title} (${count})`)));
  clear(main,
    pageHeader("Remote desk", data.ready ? `${data.ready} device(s) can open MeshCentral now. The others can still be diagnosed from this server.` : "Devices are listed even before MeshCentral is configured. Diagnose and check work now. Desktop waits for a real agent.", [
      data.meshUrl ? h("a", { class: "btn ghost", href: data.meshUrl, target: "_blank", rel: "noopener" }, "Open MeshCentral") : null,
      button("Sync MeshCentral", async () => {
        const r = await api("POST", "/api/integrations/meshcentral/sync");
        if (r.status === "not_configured") toast("MeshCentral is not configured on this server yet.", "error");
        else if (r.status === "error") toast(`Sync finished with errors: ${(r.errors || []).slice(0, 1).join(" ")}`, "error");
        else toast(`MeshCentral sync: ${r.created || 0} new, ${r.updated || 0} updated.`);
        reload();
      }, { kind: "ghost", iconName: "refresh" }),
      button("Refresh", reload, { kind: "ghost", iconName: "refresh" }),
    ]),
    deskBanner(data),
    stats,
    tabs,
    diagHost,
    table);
}

async function remoteDialog(d) {
  const tickets = await api("GET", `/api/tickets?deviceId=${d.id}&status=active&limit=20`).catch(() => ({ items: [] }));
  formDialog(`Remote session on ${d.name}`, [
    { type: "note", label: "MeshCentral opens in a new tab and asks you to sign in with your own MeshCentral account. The customer is notified and the session is recorded with your reason." },
    { name: "mode", label: "Session type", type: "select", options: [["desktop", "Remote desktop"], ["terminal", "Terminal"], ["files", "Files"], ["general", "Device page"]] },
    { name: "ticketId", label: "Related ticket", type: "select", options: [["", "None"], ...tickets.items.map((t) => [String(t.id), `${t.number} ${t.title}`])] },
    { name: "reason", label: "Reason", required: true, max: 300, full: true, placeholder: "e.g. Installing the accounts printer driver" },
  ], async (values, close) => {
    const win = window.open("about:blank", "_blank");
    try {
      const res = await api("POST", `/api/devices/${d.id}/remote`, { mode: values.mode, reason: values.reason, ticketId: values.ticketId ? Number(values.ticketId) : undefined });
      close();
      if (win && !win.closed) {
        win.location.replace(res.url);
        toast("Session recorded. If MeshCentral asks you to sign in, tick Remember this device.");
      } else {
        openMeshSession(res.url, values.mode);
      }
    } catch (error) {
      if (win && !win.closed) win.close();
      throw error;
    }
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
