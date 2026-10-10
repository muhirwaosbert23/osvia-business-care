import {
  api, badge, button, card, CATEGORIES, clear, dataTable, definitionList, download, empty, enumOptions, errorBox, fmtDate, fmtDateTime, fmtRelative,
  formDialog, h, icon, IMPACTS, isRole, isStaff, label, orgOptions, pageHeader, PRIORITIES, skeleton, staffOptions, stat, state, toast,
} from "./core.js";

const STAFF_TRANSITIONS = {
  new: ["open", "in_progress", "pending_customer", "resolved"],
  open: ["in_progress", "pending_customer", "resolved"],
  in_progress: ["open", "pending_customer", "resolved"],
  pending_customer: ["open", "in_progress", "resolved"],
  resolved: ["closed", "open"],
  closed: ["open"],
};

function healthList(health) {
  const names = { meshcentral: "MeshCentral", smtp: "Email (SMTP)", monitor_runner: "Monitoring checks", scheduler: "Background jobs", backup: "Backups" };
  return h("ul", { class: "health-list" }, Object.entries(health).map(([name, item]) => h("li", {},
    h("div", {}, h("strong", {}, names[name] || label(name)), h("small", { class: "muted" }, item.detail || "")),
    h("div", { class: "right" }, badge(item.status), item.checkedAt ? h("small", { class: "muted" }, fmtRelative(item.checkedAt)) : null))));
}

function ticketMiniTable(items) {
  if (!items.length) return empty("No open tickets", "New requests appear here.");
  return h("ul", { class: "mini-list" }, items.map((t) => h("li", {}, h("a", { href: `#/tickets/${t.id}` },
    h("span", { class: "mono" }, t.number), h("span", { class: "grow" }, t.title, isStaff() ? h("small", { class: "muted block" }, t.organizationName) : null),
    t.breached ? badge("breached", "SLA breached") : null, badge(t.priority), badge(t.status)))));
}

export async function dashboardPage(main) {
  clear(main, pageHeader("Dashboard"), skeleton(6));
  let d;
  try {
    d = await api("GET", "/api/dashboard");
  } catch (error) {
    clear(main, pageHeader("Dashboard"), errorBox(error, () => dashboardPage(main)));
    return;
  }
  const actions = [button("New ticket", () => newTicketDialog(), { kind: "primary", iconName: "plus" })];
  if (isStaff()) {
    const admin = state.me.role === "admin";
    const grid = h("div", { class: "stats" },
      stat("Open tickets", d.tickets.open, { href: "#/tickets" }),
      stat("Unassigned", d.tickets.unassigned, { tone: d.tickets.unassigned ? "warn" : "", href: "#/tickets?assigned=none" }),
      stat("Assigned to me", d.tickets.mine, { href: "#/tickets?assigned=me" }),
      stat("SLA breached", d.tickets.breached, { tone: d.tickets.breached ? "bad" : "ok", href: "#/tickets?breached=1" }),
      stat("Response due in 2 h", d.tickets.dueSoon, { tone: d.tickets.dueSoon ? "warn" : "" }),
      stat("Urgent open", d.tickets.urgent, { tone: d.tickets.urgent ? "bad" : "" }),
      stat("Devices online", `${d.devices.online || 0} / ${d.devices.total || 0}`, { hint: `${d.devices.offline || 0} offline · ${d.devices.unknown || 0} not checked`, href: "#/devices" }),
      stat("Open incidents", d.incidentsOpen, { tone: d.incidentsOpen ? "bad" : "ok", href: "#/incidents" }),
      stat("Monitors down", d.monitors.down, { tone: d.monitors.down ? "bad" : "", hint: `${d.monitors.stale} stale · ${d.monitors.total} total`, href: "#/monitoring" }),
      stat("Maintenance overdue", d.maintenanceOverdue, { tone: d.maintenanceOverdue ? "warn" : "", hint: `${d.maintenanceDueWeek} due this week`, href: "#/maintenance" }),
      admin ? stat("Organizations awaiting approval", d.organizationsPending, { tone: d.organizationsPending ? "warn" : "", href: "#/organizations?status=pending" }) : null,
      admin ? stat("Payments to verify", d.paymentsPending, { tone: d.paymentsPending ? "warn" : "", href: "#/billing" }) : null,
      admin ? stat("Overdue invoices", d.invoicesOverdue, { tone: d.invoicesOverdue ? "bad" : "", href: "#/billing" }) : null,
      admin ? stat("Renewals in 14 days", d.renewalsDue) : null,
      admin && d.emailFailed ? stat("Emails failed", d.emailFailed, { tone: "bad", href: "#/settings" }) : null,
    );
    clear(main, pageHeader(`Good ${greeting()}, ${state.me.name.split(" ")[0]}`, admin ? "Operations overview for OSVIA Business Care." : "Your queue and the systems you look after.", actions),
      grid,
      h("div", { class: "grid-2" }, card("Active tickets", ticketMiniTable(d.recentTickets), { actions: h("a", { href: "#/tickets", class: "link" }, "View all") }), card("Integration health", healthList(d.health))));
    return;
  }
  const org = d.organization;
  const banners = [];
  if (org.status === "pending") banners.push(h("div", { class: "banner warn" }, h("strong", {}, "OSVIA is reviewing your registration."), " You can explore the portal. Support requests open once your organization is approved."));
  if (org.subscriptionStatus === "past_due") banners.push(h("div", { class: "banner bad" }, h("strong", {}, "Your renewal is overdue."), " Pay the open invoice to keep full service. ", isRole("customer_admin") ? h("a", { href: "#/billing" }, "View billing") : null));
  if (d.onboardingIncomplete) banners.push(h("div", { class: "banner info" }, h("strong", {}, "Finish setting up."), " Follow the checklist to get full support. ", h("a", { href: "#/organization" }, "Open checklist")));
  if (d.windows.length) banners.push(...d.windows.map((w) => h("div", { class: "banner info" }, icon("calendar"), h("strong", {}, ` Planned maintenance: ${w.title}`), ` from ${fmtDateTime(w.startsAt)} to ${fmtDateTime(w.endsAt)}.`)));
  clear(main,
    pageHeader(org.name, `${org.planName ? `${org.planName} plan` : "No plan yet"} · ${label(org.subscriptionStatus)}${org.renewalDate ? ` · renews ${fmtDate(org.renewalDate)}` : ""}`, org.status === "active" ? actions : []),
    banners,
    h("div", { class: "stats" },
      stat("Open requests", d.tickets.open, { href: "#/tickets" }),
      stat("Waiting on you", d.tickets.waitingOnYou, { tone: d.tickets.waitingOnYou ? "warn" : "", href: "#/tickets?status=pending_customer" }),
      stat("Resolved, awaiting confirmation", d.tickets.resolved, { href: "#/tickets?status=resolved" }),
      stat(isRole("customer_user") ? "My devices online" : "Devices online", `${d.devices.online || 0} / ${d.devices.total || 0}`, { hint: `${d.devices.offline || 0} offline`, href: "#/devices" }),
      stat("Open incidents", d.incidentsOpen, { tone: d.incidentsOpen ? "bad" : "ok", href: "#/status" }),
      d.billing ? stat("Unpaid invoices", d.billing.unpaid, { tone: d.billing.overdue ? "bad" : "", hint: d.billing.pending ? `${d.billing.pending} payment(s) being verified` : "", href: "#/billing" }) : null),
    h("div", { class: "grid-2" },
      card("Recent requests", ticketMiniTable(d.recentTickets), { actions: h("a", { href: "#/tickets", class: "link" }, "View all") }),
      card("Upcoming maintenance", d.upcomingMaintenance.length ? h("ul", { class: "mini-list" }, d.upcomingMaintenance.map((m) => h("li", {}, h("span", { class: "grow" }, m.title), h("span", { class: "muted" }, fmtDate(m.nextDue))))) : empty("Nothing scheduled"))),
    state.config.escalation ? card("Urgent problem?", h("p", {}, state.config.escalation, state.config.supportPhone ? h("strong", {}, ` Support line: ${state.config.supportPhone}`) : null), { cls: "subtle" }) : null,
  );
}

function greeting() {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Africa/Kampala" }).format(new Date()));
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

function slaCell(t) {
  if (t.sla.response === "pending" && t.responseDueAt) return h("span", { class: Date.parse(t.responseDueAt) - Date.now() < 7200000 ? "text-warn" : "" }, `Reply ${fmtRelative(t.responseDueAt)}`);
  if (t.sla.response === "breached" || t.sla.resolution === "breached") return badge("breached");
  if (t.sla.resolution === "paused") return badge("paused", "Paused");
  return badge(t.sla.response);
}

export function ticketsPage(main, query) {
  const staff = isStaff();
  const filters = [
    { name: "status", label: "Status", value: query.get("status") || "active", options: [["active", "Active"], ["", "All statuses"], ...enumOptions(["new", "open", "in_progress", "pending_customer", "resolved", "closed"])] },
    { name: "priority", label: "Priority", value: query.get("priority") || "", options: enumOptions(PRIORITIES, "Any priority") },
    { name: "category", label: "Category", value: "", options: enumOptions(CATEGORIES, "Any category") },
  ];
  if (staff) filters.push({ name: "assigned", label: "Assignee", value: query.get("assigned") || "", options: [["", "Anyone"], ["me", "Assigned to me"], ["none", "Unassigned"]] });
  filters.push({ name: "breached", label: "SLA", value: query.get("breached") || "", options: [["", "Any SLA state"], ["1", "Breached"]] });
  const table = dataTable({
    columns: [
      { label: "Ticket", sort: "number", render: (t) => h("span", { class: "mono" }, t.number) },
      { label: "Subject", render: (t) => h("div", {}, h("strong", {}, t.title), staff ? h("small", { class: "muted block" }, t.organizationName) : h("small", { class: "muted block" }, label(t.category))) },
      { label: "Priority", sort: "priority", render: (t) => badge(t.priority) },
      { label: "Status", sort: "status", render: (t) => badge(t.status) },
      { label: "SLA", sort: "due", render: slaCell },
      staff ? { label: "Assignee", render: (t) => t.assigneeName || h("span", { class: "muted" }, "Unassigned") } : { label: "Requester", render: (t) => t.requesterName },
      { label: "Updated", sort: "updated", render: (t) => fmtRelative(t.updatedAt) },
    ],
    filters,
    defaultSort: { key: "updated", dir: "desc" },
    searchPlaceholder: "Search tickets",
    load: (q) => api("GET", `/api/tickets?${q}`),
    rowHref: (t) => `#/tickets/${t.id}`,
    emptyText: "No tickets match these filters.",
  });
  const canCreate = staff || state.org?.status === "active";
  clear(main, pageHeader("Tickets", staff ? "Support requests across all organizations you can see." : isRole("customer_admin") ? "Your organization's support requests." : "Support requests you have opened.", canCreate ? [button("New ticket", () => newTicketDialog(() => table.refresh()), { kind: "primary", iconName: "plus" })] : []), table.el);
}

export async function newTicketDialog(onDone) {
  const staff = isStaff();
  const fields = [];
  if (staff) fields.push({ name: "organizationId", label: "Organization", type: "select", required: true, options: await orgOptions() });
  const devices = staff ? [] : (await api("GET", "/api/devices?limit=100&sort=name&dir=asc")).items;
  fields.push(
    { name: "title", label: "Subject", required: true, max: 160, placeholder: "e.g. Printer in accounts is not printing", full: true },
    { name: "description", label: "Describe the problem", type: "textarea", required: true, max: 8000, rows: 5, full: true, help: "What happened, when it started, and who is affected. Do not include passwords." },
    { name: "category", label: "Category", type: "select", options: enumOptions(CATEGORIES), value: "other" },
    { name: "priority", label: "Priority", type: "select", options: enumOptions(PRIORITIES), value: "normal", help: "Urgent means work has stopped." },
    { name: "impact", label: "Who is affected", type: "select", options: [["single_user", "One person"], ["team", "A team or department"], ["organization", "The whole organization"]], value: "single_user" },
  );
  if (!staff) fields.push({ name: "deviceId", label: "Device (optional)", type: "select", options: [["", "Not about a specific device"], ...devices.map((d) => [String(d.id), d.name])] });
  formDialog("New support ticket", fields, async (values, close) => {
    const body = { ...values, organizationId: values.organizationId ? Number(values.organizationId) : undefined, deviceId: values.deviceId ? Number(values.deviceId) : undefined };
    const res = await api("POST", "/api/tickets", body);
    close();
    toast(`${res.ticket.number} created.`);
    onDone?.();
    location.hash = `#/tickets/${res.ticket.id}`;
  }, { submitLabel: "Create ticket", wide: true });
}

export async function ticketDetailPage(main, id) {
  clear(main, skeleton(8));
  let data;
  try {
    data = await api("GET", `/api/tickets/${id}`);
  } catch (error) {
    clear(main, pageHeader("Ticket"), errorBox(error, () => ticketDetailPage(main, id)));
    return;
  }
  render(main, data);
}

function render(main, data) {
  const { ticket: t, permissions } = data;
  const staff = isStaff();
  const reload = async () => render(main, await api("GET", `/api/tickets/${t.id}`));

  const timeline = [
    ...data.notes.map((n) => ({ at: n.createdAt, el: h("article", { class: `msg ${n.authorIsStaff ? "staff" : "customer"} ${n.visibility === "internal" ? "internal" : ""}` },
      h("header", {}, h("strong", {}, n.authorName), n.authorIsStaff ? h("span", { class: "chip" }, "OSVIA") : null,
        n.kind === "note" ? badge("pending", "Internal note") : null, n.kind === "work_log" ? badge("info", `Work log · ${n.minutesSpent} min`) : null,
        h("time", { datetime: n.createdAt }, fmtDateTime(n.createdAt))),
      h("p", { class: "pre" }, n.body)) })),
    ...data.events.filter((e) => e.fromStatus !== e.toStatus || e.note).map((e) => ({ at: e.createdAt, el: h("div", { class: "event" },
      icon("check", "icon tiny"), h("span", {}, e.fromStatus && e.fromStatus !== e.toStatus ? `${e.actorName} changed status to ${label(e.toStatus)}` : e.fromStatus ? e.actorName : `${e.actorName} opened the ticket`, e.note ? ` · ${e.note}` : ""),
      h("time", { datetime: e.createdAt }, fmtDateTime(e.createdAt))) })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const replyBox = permissions.canReply ? replyForm(t, reload) : h("p", { class: "muted" }, "This ticket is closed. Open a new ticket and mention ", h("span", { class: "mono" }, t.number), " if the problem returns.");

  const attachments = card("Attachments", [
    data.attachments.length ? h("ul", { class: "files" }, data.attachments.map((f) => h("li", {},
      icon("clip", "icon tiny"),
      h("button", { type: "button", class: "link", onclick: () => download(`/api/attachments/${f.id}`).catch((e) => toast(e.message, "error")) }, f.name),
      h("small", { class: "muted" }, `${Math.ceil(f.size / 1024)} KB · ${f.uploader}`),
      f.visibility === "internal" ? badge("pending", "Internal") : null))) : h("p", { class: "muted small" }, "No files yet."),
    t.status !== "closed" ? uploadControl(t, reload) : null,
  ]);

  const side = [
    card("Details", definitionList([
      staff ? ["Organization", h("a", { href: `#/organizations/${t.organizationId}` }, t.organizationName)] : null,
      ["Requester", t.requesterName],
      ["Category", label(t.category)],
      ["Impact", label(t.impact)],
      ["Device", t.deviceId ? h("a", { href: `#/devices/${t.deviceId}` }, t.deviceName) : null],
      ["Assigned to", t.assigneeName || "Not yet assigned"],
      ["Opened", fmtDateTime(t.createdAt)],
      t.resolvedAt ? ["Resolved", fmtDateTime(t.resolvedAt)] : null,
      staff ? ["Time logged", `${t.minutesLogged} min`] : null,
    ])),
    card("Service level", definitionList([
      ["Policy", t.policyName || "No SLA policy"],
      ["First response", [badge(t.sla.response), t.responseDueAt ? h("small", { class: "muted block" }, `Due ${fmtDateTime(t.responseDueAt)}`) : null, t.firstResponseAt ? h("small", { class: "muted block" }, `Answered ${fmtDateTime(t.firstResponseAt)}`) : null]],
      ["Resolution", [badge(t.sla.resolution), t.resolutionDueAt ? h("small", { class: "muted block" }, t.slaPaused ? "Clock paused while waiting on the customer" : `Due ${fmtDateTime(t.resolutionDueAt)}`) : null]],
    ]), { cls: "subtle" }),
    staff ? staffControls(t, reload) : customerControls(t, permissions, reload),
  ];

  clear(main,
    h("a", { href: "#/tickets", class: "back" }, "← All tickets"),
    pageHeader(t.title, null, [badge(t.priority), badge(t.status)]),
    h("p", { class: "muted mono" }, t.number),
    h("div", { class: "detail" },
      h("div", { class: "detail-main" },
        card(null, [h("article", { class: "msg customer first" }, h("header", {}, h("strong", {}, t.requesterName), h("time", {}, fmtDateTime(t.createdAt))), h("p", { class: "pre" }, t.description))]),
        t.resolutionSummary ? card("Resolution", h("p", { class: "pre" }, t.resolutionSummary), { cls: "ok-card" }) : null,
        card("Conversation", [timeline.length ? h("div", { class: "timeline" }, timeline.map((x) => x.el)) : h("p", { class: "muted" }, "No replies yet."), replyBox]),
        attachments),
      h("aside", { class: "detail-side" }, side)));
}

function replyForm(t, reload) {
  const staff = isStaff();
  const text = h("textarea", { rows: 4, maxlength: 8000, "aria-label": "Message", placeholder: staff ? "Write a reply to the customer, or an internal note" : "Write a reply to OSVIA" });
  const kind = staff ? h("select", { "aria-label": "Entry type", onchange: () => minutes.classList.toggle("hidden", kind.value !== "work_log") },
    h("option", { value: "reply" }, "Reply to customer"), h("option", { value: "note" }, "Internal note"), h("option", { value: "work_log" }, "Work log (internal)")) : null;
  const minutes = h("input", { type: "number", min: 1, max: 1440, class: "hidden narrow", placeholder: "Minutes", "aria-label": "Minutes spent" });
  const send = button("Send", async () => {
    if (!text.value.trim()) throw new Error("Write a message first.");
    await api("POST", `/api/tickets/${t.id}/notes`, { body: text.value, kind: kind?.value || "reply", minutesSpent: minutes.value ? Number(minutes.value) : undefined });
    toast(kind?.value === "reply" || !kind ? "Reply sent." : "Saved.");
    await reload();
  }, { kind: "primary" });
  return h("div", { class: "reply" }, text, h("div", { class: "row" }, kind, minutes, h("div", { class: "spacer" }), send),
    !staff && t.status === "pending_customer" ? h("p", { class: "small muted" }, "Replying moves the ticket back to OSVIA and resumes the service-level clock.") : null);
}

function uploadControl(t, reload) {
  const input = h("input", { type: "file", accept: ".png,.jpg,.jpeg,.pdf,.txt,image/png,image/jpeg,application/pdf,text/plain", class: "hidden" });
  const internal = isStaff() ? h("label", { class: "check inline" }, h("input", { type: "checkbox" }), " Internal only") : null;
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast("Files must be 5 MB or smaller.", "error");
      return;
    }
    try {
      await api("POST", `/api/tickets/${t.id}/attachments`, file, { raw: true, headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-Visibility": internal?.querySelector("input").checked ? "internal" : "customer" } });
      toast("File attached.");
      await reload();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      input.value = "";
    }
  });
  return h("div", { class: "row" }, button("Attach file", () => input.click(), { kind: "ghost", iconName: "clip" }), internal, input, h("small", { class: "muted" }, "PNG, JPEG, PDF or text, up to 5 MB."));
}

function staffControls(t, reload) {
  const status = h("select", { "aria-label": "Status" }, h("option", { value: t.status }, `${label(t.status)} (current)`), STAFF_TRANSITIONS[t.status].filter((s) => s !== "open" || t.status !== "closed" || state.me.role === "admin").map((s) => h("option", { value: s }, label(s))));
  const priority = h("select", { "aria-label": "Priority" }, PRIORITIES.map((p) => h("option", { value: p }, label(p))));
  priority.value = t.priority;
  const category = h("select", { "aria-label": "Category" }, CATEGORIES.map((c) => h("option", { value: c }, label(c))));
  category.value = t.category;
  const impact = h("select", { "aria-label": "Impact" }, IMPACTS.map((c) => h("option", { value: c }, label(c))));
  impact.value = t.impact;
  const assignee = h("select", { "aria-label": "Assignee" }, h("option", { value: "" }, "Unassigned"));
  staffOptions().then((opts) => {
    for (const [value, text] of opts) {
      if (state.me.role === "technician" && Number(value) !== state.me.id && Number(value) !== t.assignedTo) continue;
      assignee.append(h("option", { value }, text));
    }
    assignee.value = t.assignedTo ? String(t.assignedTo) : "";
  });
  const summary = h("textarea", { rows: 3, maxlength: 8000, "aria-label": "Resolution summary", placeholder: "What was done to fix it (shown to the customer)" });
  summary.value = t.resolutionSummary;
  const save = button("Save changes", async () => {
    const body = {};
    if (status.value !== t.status) body.status = status.value;
    if (priority.value !== t.priority) body.priority = priority.value;
    if (category.value !== t.category) body.category = category.value;
    if (impact.value !== t.impact) body.impact = impact.value;
    if ((assignee.value || null) !== (t.assignedTo ? String(t.assignedTo) : null)) body.assignedTo = assignee.value ? Number(assignee.value) : null;
    if (summary.value.trim() !== t.resolutionSummary) body.resolutionSummary = summary.value;
    if (!Object.keys(body).length) {
      toast("Nothing changed.");
      return;
    }
    await api("PATCH", `/api/tickets/${t.id}`, body);
    toast("Ticket updated.");
    await reload();
  }, { kind: "primary block" });
  const takeIt = !t.assignedTo ? button("Assign to me", async () => {
    await api("PATCH", `/api/tickets/${t.id}`, { assignedTo: state.me.id });
    toast("Assigned to you.");
    await reload();
  }, { kind: "ghost block" }) : null;
  return card("Manage", h("div", { class: "stack" },
    takeIt,
    h("label", { class: "field" }, h("span", {}, "Status"), status),
    h("label", { class: "field" }, h("span", {}, "Assignee"), assignee),
    h("label", { class: "field" }, h("span", {}, "Priority"), priority),
    h("label", { class: "field" }, h("span", {}, "Category"), category),
    h("label", { class: "field" }, h("span", {}, "Impact"), impact),
    h("label", { class: "field" }, h("span", {}, "Resolution summary"), summary),
    h("small", { class: "muted" }, "A resolution summary is required to resolve. Changing priority or category recalculates the SLA from the ticket's creation time."),
    save));
}

function customerControls(t, permissions, reload) {
  const buttons = [];
  if (permissions.canClose) buttons.push(button("Confirm it is fixed", async () => {
    await api("POST", `/api/tickets/${t.id}/close`);
    toast("Thank you. The ticket is closed.");
    await reload();
  }, { kind: "primary block", iconName: "check" }));
  if (permissions.canReopen) buttons.push(button("It is still not working", async () => {
    await api("POST", `/api/tickets/${t.id}/reopen`);
    toast("Reopened. OSVIA has been told.");
    await reload();
  }, { kind: "ghost block" }));
  if (!buttons.length) return null;
  return card("Is it fixed?", h("div", { class: "stack" }, h("p", { class: "small muted" }, "OSVIA marked this resolved. Confirm or reopen it."), buttons));
}
