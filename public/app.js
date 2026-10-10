const app = document.getElementById("app");
const state = { user: null, view: "login", config: null, error: "", notice: "", query: {}, page: 1, params: {}, needsSetup: false };
let csrf = "";

const customerNav = [
  ["dashboard", "Dashboard"],
  ["devices", "Devices"],
  ["tickets", "Tickets"],
  ["maintenance", "Maintenance"],
  ["plan", "Plan"],
  ["notifications", "Notifications"],
  ["contact", "Contact"],
];
const staffNav = [
  ["dashboard", "Dashboard"],
  ["organizations", "Organizations"],
  ["devices", "Devices"],
  ["tickets", "Tickets"],
  ["maintenance", "Maintenance"],
  ["schedules", "Schedules"],
  ["plans", "Plans"],
  ["payments", "Payments"],
  ["notifications", "Notifications"],
  ["audit", "Audit"],
  ["contact", "Contact"],
];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function money(value) {
  return `UGX ${Number(value || 0).toLocaleString("en-US")}`;
}
function when(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function label(value) {
  return String(value || "").replaceAll("_", " ");
}

async function api(path, options = {}) {
  const headers = { Accept: "application/json" };
  if (options.body) headers["Content-Type"] = "application/json";
  if (csrf && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrf;
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...headers, ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The request failed.");
  return data;
}

function render() {
  if (!state.user) {
    app.innerHTML = authShell();
    return;
  }
  const items = state.user.role === "customer" ? customerNav : staffNav;
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <p class="brand">Business Care<small>OSVIA Technologies</small></p>
        <button class="menu" type="button" data-action="menu">Menu</button>
        <nav class="nav">
          ${items.map(([id, name]) => `<button type="button" data-action="nav" data-nav="${id}" ${state.view === id ? 'aria-current="page"' : ""}>${name}</button>`).join("")}
        </nav>
      </aside>
      <main class="main">
        <div class="top">
          <h2>${esc(titleFor(state.view))}</h2>
          <div class="who">${esc(state.user.name)} · ${esc(state.user.role)} <button class="secondary" type="button" data-action="logout">Sign out</button></div>
        </div>
        ${state.error ? `<div class="alert" id="alert" role="alert">${esc(state.error)}</div>` : `<div id="alert"></div>`}
        ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ""}
        <div id="content">Loading…</div>
      </main>
    </div>`;
  load().catch((error) => setError(error.message));
}

function titleFor(view) {
  return [...customerNav, ...staffNav].find(([id]) => id === view)?.[1] || "OSVIA Business Care";
}

function authShell() {
  const form = state.needsSetup ? setupForm() : state.view === "register" ? registerForm() : loginForm();
  return `
    <div class="auth">
      <section class="auth-brand">
        <div>
          <p class="eyebrow">OSVIA Technologies · Kampala</p>
          <h1>Business Care</h1>
          <p>Managed IT support for organizations. This computer is running the local portal. Remote device control stays off until MeshCentral is connected.</p>
        </div>
        <p><a href="https://osviatech.com" style="color:#f6f1e7">osviatech.com</a></p>
      </section>
      <section class="auth-panel">
        <div class="panel">
          ${state.error ? `<div class="alert" id="alert" role="alert">${esc(state.error)}</div>` : `<div id="alert"></div>`}
          ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ""}
          ${form}
        </div>
      </section>
    </div>`;
}

function setupForm() {
  return `<h2>Create the administrator</h2><p>This account is created once, the first time the portal starts.</p>
    <form data-form="setup">
      <label>Name<input name="name" required maxlength="120" autocomplete="name"></label>
      <label>Email<input name="email" type="email" required autocomplete="username"></label>
      <label>Password<input name="password" type="password" required minlength="10" autocomplete="new-password"></label>
      <button class="primary" type="submit">Create administrator</button>
    </form>`;
}
function loginForm() {
  return `<h2>Sign in</h2>
    <form data-form="login">
      <label>Email<input name="email" type="email" required autocomplete="username"></label>
      <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
      <button class="primary" type="submit">Sign in</button>
    </form>
    <p><button class="text-button" type="button" data-action="show-register">Register an organization</button></p>`;
}
function registerForm() {
  return `<h2>Register an organization</h2><p>The subscription stays unpaid until OSVIA confirms a payment and activates the plan.</p>
    <form data-form="register">
      <label>Organization<input name="organizationName" required maxlength="160"></label>
      <label>Your name<input name="contactName" required maxlength="120"></label>
      <label>Email<input name="email" type="email" required></label>
      <label>Phone<input name="phone" maxlength="40"></label>
      <label>Location<input name="location" maxlength="160"></label>
      <label>Password<input name="password" type="password" required minlength="10" autocomplete="new-password"></label>
      <button class="primary" type="submit">Register</button>
    </form>
    <p><button class="text-button" type="button" data-action="show-login">Back to sign in</button></p>`;
}

function setError(message) {
  state.error = message || "";
  const alert = document.getElementById("alert");
  if (!alert) return;
  alert.className = message ? "alert" : "";
  alert.textContent = message || "";
}

async function load() {
  const slot = document.getElementById("content");
  if (!slot || !views[state.view]) return;
  const data = await views[state.view].load();
  if (document.getElementById("content") !== slot) return;
  slot.innerHTML = views[state.view].draw(data);
}

function qs(extra = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...state.query, page: String(state.page), ...extra })) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

function table(headers, rows) {
  if (!rows.length) return `<p class="empty">Nothing is stored here yet.</p>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
function pager(data) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return `<div class="row"><button class="secondary" type="button" data-action="page" data-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>Previous</button><span>Page ${data.page} of ${pages}</span><button class="secondary" type="button" data-action="page" data-page="${data.page + 1}" ${data.page >= pages ? "disabled" : ""}>Next</button></div>`;
}
function orgOptions(items, selected) {
  return `<option value="">Choose</option>${items.map((org) => `<option value="${org.id}" ${String(selected) === String(org.id) ? "selected" : ""}>${esc(org.name)}</option>`).join("")}`;
}

const views = {
  dashboard: {
    async load() { return api("/api/dashboard"); },
    draw(data) {
      if (data.role === "customer") {
        const org = data.organization;
        return `<div class="grid">
          <article class="card"><span>Open tickets</span><strong>${data.openTickets}</strong></article>
          <article class="card"><span>Online</span><strong>${data.onlineDevices}</strong><em>From the latest address check</em></article>
          <article class="card"><span>Offline</span><strong>${data.offlineDevices}</strong></article>
          <article class="card"><span>Subscription</span><strong>${esc(label(org?.subscriptionStatus || "unpaid"))}</strong><em>${esc(org?.planName || "No plan assigned")}</em></article>
          <article class="card"><span>Renewal date</span><strong>${esc(org?.renewalDate || "—")}</strong></article>
        </div><div class="notice">A device is online only after a ping or port check succeeds. Devices without an address stay not checked.</div>
        <h3>Recent tickets</h3>
        ${table(["Ticket", "Status", "Priority"], data.recentTickets.map((ticket) => `<tr><td><button class="text-button" type="button" data-action="open" data-view="ticket" data-id="${ticket.id}">#${ticket.id} ${esc(ticket.title)}</button></td><td>${esc(label(ticket.status))}</td><td>${esc(ticket.priority)}</td></tr>`))}`;
      }
      return `<div class="grid">
        <article class="card"><span>Organizations</span><strong>${data.organizations}</strong></article>
        <article class="card"><span>Open tickets</span><strong>${data.openTickets}</strong></article>
        <article class="card"><span>Online</span><strong>${data.onlineDevices}</strong><em>${data.devices} devices registered</em></article>
        <article class="card"><span>Offline</span><strong>${data.offlineDevices}</strong><em>Failed the latest address check</em></article>
        <article class="card"><span>Not on an active plan</span><strong>${data.unpaid}</strong></article>
        <article class="card"><span>Average resolution</span><strong>${data.averageResolutionHours == null ? "—" : `${data.averageResolutionHours} h`}</strong><em>From resolved tickets only</em></article>
      </div><div class="notice">Online and offline are the result of checking each device address. A device with no address is not marked either way.</div>`;
    },
  },
  devices: {
    async load() {
      const [devices, orgs] = await Promise.all([
        api(`/api/devices?${qs()}`),
        state.user.role === "customer" ? Promise.resolve({ items: [] }) : api("/api/organizations?limit=100"),
      ]);
      return { devices, orgs: orgs.items };
    },
    draw({ devices, orgs }) {
      const orgField = state.user.role === "customer" ? "" : `<label>Organization<select name="organizationId" required>${orgOptions(orgs)}</select></label>`;
      return `<p class="notice">Add the computer's IP address or hostname. The portal pings it, or connects to the port you enter, and shows Online or Offline from that result. Checks repeat about once a minute.</p>
        <form class="filters" data-form="search"><label>Search<input name="q" value="${esc(state.query.q || "")}"></label><button class="primary" type="submit">Search</button></form>
        ${table(["Device", "Address", "Connection", "Last seen online", ""], devices.items.map((device) => `<tr>
          <td>${esc(device.name)}<br><span class="who">${esc(device.organizationName)} · ${esc(device.operatingSystem || "System not recorded")}</span></td>
          <td>${esc(device.address || "—")}${device.checkPort ? `:${esc(device.checkPort)}` : ""}</td>
          <td><span class="pill ${device.reachability === "online" ? "ok" : device.reachability === "offline" ? "warn" : ""}">${device.reachability === "online" ? "Online" : device.reachability === "offline" ? "Offline" : "Not checked"}</span></td>
          <td>${device.lastConnection ? esc(when(device.lastConnection)) : "No successful check yet"}</td>
          <td class="row">${device.address ? `<button class="secondary" type="button" data-action="check-device" data-id="${device.id}">Check now</button>` : ""}${device.managementStatus === "consent_recorded" ? "" : `<button class="secondary" type="button" data-action="consent" data-id="${device.id}">Record consent</button>`}</td>
        </tr>`))}
        ${pager(devices)}
        <form class="form-card stack" data-form="device"><h3>Register a device</h3>${orgField}
          <label>Name<input name="name" required maxlength="120"></label>
          <label>Operating system<input name="operatingSystem" maxlength="80"></label>
          <label>IP address or hostname<input name="address" placeholder="192.168.1.20" maxlength="253"></label>
          <label>Port, if you want a port check instead of ping<input name="checkPort" type="number" min="1" max="65535"></label>
          <button class="primary" type="submit">Save and check</button>
        </form>`;
    },
  },
  tickets: {
    async load() {
      const [tickets, orgs] = await Promise.all([
        api(`/api/tickets?${qs()}`),
        state.user.role === "customer" ? Promise.resolve({ items: [] }) : api("/api/organizations?limit=100"),
      ]);
      return { tickets, orgs: orgs.items };
    },
    draw({ tickets, orgs }) {
      const orgField = state.user.role === "customer" ? "" : `<label>Organization<select name="organizationId" required>${orgOptions(orgs, state.query.organizationId)}</select></label>`;
      return `<form class="filters" data-form="search">
          <label>Search<input name="q" value="${esc(state.query.q || "")}"></label>
          <label>Status<select name="status"><option value="">Any</option>${["open", "assigned", "in_progress", "resolved", "closed"].map((status) => `<option ${state.query.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></label>
          <label>Priority<select name="priority"><option value="">Any</option>${["low", "normal", "high", "urgent"].map((priority) => `<option ${state.query.priority === priority ? "selected" : ""}>${priority}</option>`).join("")}</select></label>
          <button class="primary" type="submit">Filter</button>
        </form>
        ${table(["Ticket", "Organization", "Status", "Priority"], tickets.items.map((ticket) => `<tr>
          <td><button class="text-button" type="button" data-action="open" data-view="ticket" data-id="${ticket.id}">#${ticket.id} ${esc(ticket.title)}</button></td>
          <td>${esc(ticket.organizationName)}</td><td>${esc(label(ticket.status))}</td><td>${esc(ticket.priority)}</td></tr>`))}
        ${pager(tickets)}
        <form class="form-card" data-form="ticket"><h3>New ticket</h3>${orgField}
          <label>Title<input name="title" required maxlength="160"></label>
          <label>Priority<select name="priority"><option>normal</option><option>low</option><option>high</option><option>urgent</option></select></label>
          <label>Description<textarea name="description" required maxlength="5000"></textarea></label>
          <button class="primary" type="submit">Create ticket</button>
        </form>`;
    },
  },
  ticket: {
    async load() {
      const [detail, staff] = await Promise.all([
        api(`/api/tickets/${state.params.id}`),
        state.user.role === "customer" ? Promise.resolve({ items: [] }) : api("/api/users?role=staff&limit=100"),
      ]);
      return { ...detail, staff: staff.items };
    },
    draw({ ticket, notes, staff }) {
      const staffForm = state.user.role === "customer" ? "" : `<form class="form-card" data-form="ticket-update">
          <h3>Assignment and resolution</h3>
          <label>Status<select name="status">${["open", "assigned", "in_progress", "resolved", "closed"].map((status) => `<option ${ticket.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></label>
          <label>Priority<select name="priority">${["low", "normal", "high", "urgent"].map((priority) => `<option ${ticket.priority === priority ? "selected" : ""}>${priority}</option>`).join("")}</select></label>
          <label>Assignee<select name="assignedTo"><option value="">Unassigned</option>${staff.map((person) => `<option value="${person.id}" ${ticket.assignedTo === person.id ? "selected" : ""}>${esc(person.name)} (${esc(person.role)})</option>`).join("")}</select></label>
          <label>Resolution summary<textarea name="resolutionSummary">${esc(ticket.resolutionSummary)}</textarea></label>
          <button class="primary" type="submit">Save ticket</button>
        </form>`;
      return `<article class="card"><h3>#${ticket.id} ${esc(ticket.title)}</h3><p>${esc(ticket.description)}</p>
          <p><span class="pill">${esc(label(ticket.status))}</span> <span class="pill">${esc(ticket.priority)}</span></p>
          <p>Opened by ${esc(ticket.creatorName)} · ${esc(when(ticket.createdAt))}</p>
          ${ticket.resolutionSummary ? `<p><strong>Resolution.</strong> <span class="note">${esc(ticket.resolutionSummary)}</span></p>` : ""}
        </article>
        <div class="split stack">
          <section class="form-card"><h3>Notes</h3>
            ${notes.length ? notes.map((note) => `<article><p class="note">${esc(note.body)}</p><p class="who">${esc(note.authorName)} · ${esc(label(note.visibility))} · ${esc(label(note.kind))} · ${esc(when(note.createdAt))}</p></article>`).join("") : `<p class="empty">No notes yet.</p>`}
            <form data-form="note">
              <label>Add a note<textarea name="body" required></textarea></label>
              ${state.user.role === "customer" ? "" : `<label>Visibility<select name="visibility"><option value="customer">Customer can see this</option><option value="internal">Internal</option></select></label><label>Type<select name="kind"><option value="comment">Comment</option><option value="work_log">Work log</option></select></label>`}
              <button class="primary" type="submit">Add note</button>
            </form>
          </section>
          ${staffForm}
        </div>`;
    },
  },
  organizations: {
    async load() { return api(`/api/organizations?${qs()}`); },
    draw(data) {
      return `<form class="filters" data-form="search"><label>Search<input name="q" value="${esc(state.query.q || "")}"></label><button class="primary" type="submit">Search</button></form>
        ${table(["Organization", "Contact", "Subscription", "Renewal"], data.items.map((org) => `<tr>
          <td><button class="text-button" type="button" data-action="open" data-view="organization" data-id="${org.id}">${esc(org.name)}</button></td>
          <td>${esc(org.contactName)}<br>${esc(org.contactEmail)}</td>
          <td><span class="pill ${org.subscriptionStatus === "active" ? "ok" : "warn"}">${esc(label(org.subscriptionStatus))}</span></td>
          <td>${esc(org.renewalDate || "—")}</td></tr>`))}
        ${pager(data)}
        <form class="form-card" data-form="organization"><h3>Add an organization</h3>
          <label>Name<input name="name" required></label>
          <label>Contact name<input name="contactName" required></label>
          <label>Contact email<input name="contactEmail" type="email" required></label>
          <label>Phone<input name="contactPhone"></label>
          <label>Location<input name="location"></label>
          <button class="primary" type="submit">Save organization</button>
        </form>`;
    },
  },
  organization: {
    async load() {
      const [org, users, plans] = await Promise.all([
        api(`/api/organizations/${state.params.id}`),
        api(`/api/users?organizationId=${state.params.id}&limit=100`),
        api("/api/plans"),
      ]);
      return { ...org, users: users.items, plans: plans.items };
    },
    draw({ organization, users, plans }) {
      const activate = state.user.role === "admin" ? `<form data-form="activate"><label>Plan<select name="planId">${plans.filter((plan) => plan.active).map((plan) => `<option value="${plan.id}" ${organization.planId === plan.id ? "selected" : ""}>${esc(plan.name)} · ${money(plan.priceUgx)}</option>`).join("")}</select></label><button class="primary" type="submit">Activate subscription</button></form>` : "";
      return `<article class="card"><h3>${esc(organization.name)}</h3>
          <p>${esc(organization.contactName)} · ${esc(organization.contactEmail)}${organization.contactPhone ? ` · ${esc(organization.contactPhone)}` : ""}${organization.location ? ` · ${esc(organization.location)}` : ""}</p>
          <p>Status ${esc(label(organization.status))} · Subscription ${esc(label(organization.subscriptionStatus))} · Renewal ${esc(organization.renewalDate || "—")}</p>
          ${activate}
          <p class="who">Activation requires a confirmed payment. Recording a payment does not mark the organization as paid.</p>
        </article>
        <h3>Authorized users</h3>
        ${table(["Name", "Email", "Role"], users.map((user) => `<tr><td>${esc(user.name)}</td><td>${esc(user.email)}</td><td>${esc(user.role)}</td></tr>`))}
        <form class="form-card" data-form="user"><h3>Add a customer user</h3>
          <input type="hidden" name="organizationId" value="${organization.id}">
          <input type="hidden" name="role" value="customer">
          <label>Name<input name="name" required></label>
          <label>Email<input name="email" type="email" required></label>
          <label>Temporary password<input name="password" type="password" minlength="10" required autocomplete="new-password"></label>
          <button class="primary" type="submit">Create user</button>
        </form>`;
    },
  },
  plans: {
    async load() { return api("/api/plans"); },
    draw(data) {
      return data.items.map((plan) => `<form class="form-card" data-form="plan">
        <input type="hidden" name="id" value="${plan.id}">
        <label>Name<input name="name" value="${esc(plan.name)}" ${state.user.role === "admin" ? "" : "disabled"}></label>
        <label>Price UGX<input name="priceUgx" type="number" value="${plan.priceUgx}" ${state.user.role === "admin" ? "" : "disabled"}></label>
        <label>Device limit<input name="deviceLimit" type="number" value="${plan.deviceLimit}" ${state.user.role === "admin" ? "" : "disabled"}></label>
        <label>Included support hours<input name="supportHours" type="number" value="${plan.supportHours}" ${state.user.role === "admin" ? "" : "disabled"}></label>
        <label>Response target hours<input name="responseTargetHours" type="number" value="${plan.responseTargetHours}" ${state.user.role === "admin" ? "" : "disabled"}></label>
        <label>Description<textarea name="description" ${state.user.role === "admin" ? "" : "disabled"}>${esc(plan.description)}</textarea></label>
        ${state.user.role === "admin" ? `<button class="primary" type="submit">Save plan</button>` : ""}
      </form>`).join("");
    },
  },
  payments: {
    async load() {
      const [payments, orgs] = await Promise.all([api(`/api/payments?${qs()}`), api("/api/organizations?limit=100")]);
      return { payments, orgs: orgs.items };
    },
    draw({ payments, orgs }) {
      return `${table(["Organization", "Amount", "Method", "Reference", "Status", ""], payments.items.map((payment) => `<tr>
          <td>${payment.organizationId}</td><td>${money(payment.amountUgx)}</td><td>${esc(label(payment.method))}</td><td>${esc(payment.reference)}</td>
          <td><span class="pill ${payment.status === "confirmed" ? "ok" : "warn"}">${esc(payment.status)}</span></td>
          <td>${state.user.role === "admin" && payment.status === "recorded" ? `<button class="secondary" type="button" data-action="confirm-payment" data-id="${payment.id}">Confirm</button>` : ""}</td>
        </tr>`))}
        ${pager(payments)}
        <form class="form-card" data-form="payment"><h3>Record a manual payment</h3>
          <p>This stores the payment. It does not process mobile money, and it does not activate the subscription.</p>
          <label>Organization<select name="organizationId" required>${orgOptions(orgs)}</select></label>
          <label>Amount UGX<input name="amountUgx" type="number" min="1" required></label>
          <label>Method<select name="method"><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="other">Other</option></select></label>
          <label>Reference<input name="reference" required maxlength="120"></label>
          <label>Note<textarea name="note"></textarea></label>
          <button class="primary" type="submit">Record payment</button>
        </form>`;
    },
  },
  plan: {
    async load() {
      const [dashboard, payments] = await Promise.all([api("/api/dashboard"), api("/api/payments")]);
      return { dashboard, payments };
    },
    draw({ dashboard, payments }) {
      const org = dashboard.organization;
      return `<article class="card"><h3>${esc(org?.planName || "No plan assigned")}</h3>
          <p>${org?.priceUgx ? money(org.priceUgx) + " per month" : "Price appears after a plan is assigned."}</p>
          <p>Subscription ${esc(label(org?.subscriptionStatus || "unpaid"))}. Renewal ${esc(org?.renewalDate || "not set")}.</p>
          <p>A plan becomes active only after OSVIA confirms a payment and activates the subscription.</p>
        </article>
        <h3>Payment records</h3>
        ${table(["Amount", "Reference", "Status"], payments.items.map((payment) => `<tr><td>${money(payment.amountUgx)}</td><td>${esc(payment.reference)}</td><td>${esc(payment.status)}</td></tr>`))}`;
    },
  },
  maintenance: {
    async load() {
      if (state.user.role === "customer") return { report: await api("/api/maintenance"), orgs: [] };
      const orgs = await api("/api/organizations?limit=100");
      const organizationId = state.query.organizationId || orgs.items[0]?.id;
      const report = organizationId ? await api(`/api/maintenance?organizationId=${organizationId}`) : { records: [], tickets: [], organization: null };
      return { report, orgs: orgs.items, organizationId };
    },
    draw({ report, orgs, organizationId }) {
      const picker = state.user.role === "customer" ? "" : `<form class="filters" data-form="search"><label>Organization<select name="organizationId">${orgOptions(orgs, organizationId)}</select></label><button class="primary" type="submit">Show</button></form>`;
      const pdf = organizationId || state.user.role === "customer" ? `<p><a href="/api/reports/maintenance.pdf${organizationId ? `?organizationId=${organizationId}` : ""}">Download PDF</a></p>` : "";
      const form = state.user.role === "customer" ? "" : `<form class="form-card" data-form="maintenance"><h3>Record maintenance</h3>
          <input type="hidden" name="organizationId" value="${organizationId || ""}">
          <label>Date<input name="performedAt" type="date" required></label>
          <label>Summary<textarea name="summary" required></textarea></label>
          <button class="primary" type="submit">Save record</button></form>`;
      return `${picker}${pdf}<h3>Maintenance</h3>${table(["Date", "Device", "Summary", "Technician"], (report.records || []).map((record) => `<tr><td>${esc(record.performedAt)}</td><td>${esc(record.deviceName || "—")}</td><td class="note">${esc(record.summary)}</td><td>${esc(record.technicianName)}</td></tr>`))}
        <h3>Incident history</h3>${table(["Ticket", "Status", "Opened"], (report.tickets || []).map((ticket) => `<tr><td>#${ticket.id} ${esc(ticket.title)}</td><td>${esc(label(ticket.status))}</td><td>${esc(when(ticket.createdAt))}</td></tr>`))}${form}`;
    },
  },
  schedules: {
    async load() {
      const [schedules, orgs] = await Promise.all([api(`/api/schedules?${qs()}`), api("/api/organizations?limit=100")]);
      return { schedules, orgs: orgs.items };
    },
    draw({ schedules, orgs }) {
      return `${table(["When", "Organization", "Task"], schedules.items.map((item) => `<tr><td>${esc(item.nextDue)}</td><td>${esc(item.organizationName)}</td><td>${esc(item.title)}<br><span class="who">${esc(item.notes)}</span></td></tr>`))}
        <form class="form-card" data-form="schedule"><h3>Schedule maintenance</h3>
          <label>Organization<select name="organizationId" required>${orgOptions(orgs)}</select></label>
          <label>Title<input name="title" required></label>
          <label>Next due<input name="nextDue" type="date" required></label>
          <label>Repeat every days<input name="intervalDays" type="number" min="1"></label>
          <label>Notes<textarea name="notes"></textarea></label>
          <button class="primary" type="submit">Save schedule</button>
        </form>`;
    },
  },
  notifications: {
    async load() { return api("/api/notifications"); },
    draw(data) {
      if (!data.items.length) return `<p class="empty">No notifications yet. Ticket updates, confirmed payments, and renewal dates appear here.</p>`;
      return data.items.map((item) => `<article class="card"><strong>${esc(item.title)}</strong><p class="note">${esc(item.body)}</p><p class="who">${esc(when(item.createdAt))} ${item.readAt ? "· Read" : ""}</p>${item.readAt ? "" : `<button class="secondary" type="button" data-action="read" data-id="${item.id}">Mark read</button>`}</article>`).join("");
    },
  },
  audit: {
    async load() { return api(`/api/audit?${qs()}`); },
    draw(data) {
      return `${table(["When", "Who", "Action", "Record"], data.items.map((item) => `<tr><td>${esc(when(item.createdAt))}</td><td>${esc(item.actorName)}</td><td>${esc(item.action)}</td><td>${esc(item.entityType)} ${esc(item.entityId || "")}</td></tr>`))}${pager(data)}`;
    },
  },
  contact: {
    async load() { return api("/api/service-status"); },
    draw(status) {
      const config = state.config || {};
      return `<article class="card"><h3>${esc(config.company || "OSVIA TECHNOLOGIES")}</h3>
          <p>${esc(config.location || "Kampala, Uganda")}</p>
          <p><a href="${esc(config.website || "https://osviatech.com")}">osviatech.com</a></p>
          ${config.contactEmail ? `<p>Email ${esc(config.contactEmail)}</p>` : ""}
          ${config.contactPhone ? `<p>Phone ${esc(config.contactPhone)}</p>` : "<p>Add CONTACT_EMAIL and CONTACT_PHONE in the environment file to show a direct phone line.</p>"}
          <h3>Escalation</h3>
          <ol>
            <li>Open a ticket and set the priority to urgent.</li>
            <li>If the organization cannot work, contact OSVIA through the website while the ticket is open.</li>
            <li>An administrator reviews urgent tickets before routine work.</li>
          </ol>
          <p>Support desk: ${esc(status.desk)}. ${esc(status.detail)}</p>
        </article>`;
    },
  },
};

const forms = {
  async setup(form) {
    const data = await api("/api/setup", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    enter(data);
  },
  async login(form) {
    const data = await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    enter(data);
  },
  async register(form) {
    await api("/api/register", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    state.view = "login";
    state.notice = "Organization registered. Sign in with that email. The subscription stays unpaid until OSVIA activates it.";
    state.error = "";
    render();
  },
  async search(form) {
    state.query = Object.fromEntries([...form.entries()].filter(([, value]) => value));
    state.page = 1;
    state.error = "";
    state.notice = "";
    render();
  },
  async device(form) {
    const body = Object.fromEntries(form);
    if (body.checkPort) body.checkPort = Number(body.checkPort);
    else delete body.checkPort;
    const saved = await api("/api/devices", { method: "POST", body: JSON.stringify(body) });
    const stateLabel = saved.device.reachability === "online" ? "Online" : saved.device.reachability === "offline" ? "Offline" : "Not checked";
    state.notice = `Device saved. Connection: ${stateLabel}.`;
    render();
  },
  async ticket(form) { await api("/api/tickets", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); state.notice = "Ticket created."; render(); },
  async organization(form) { await api("/api/organizations", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); state.notice = "Organization saved."; render(); },
  async user(form) { await api("/api/users", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); state.notice = "User created. Share the password through a channel you trust."; render(); },
  async payment(form) {
    const body = Object.fromEntries(form);
    body.amountUgx = Number(body.amountUgx);
    await api("/api/payments", { method: "POST", body: JSON.stringify(body) });
    state.notice = "Payment recorded. It is not confirmed and the subscription is not active.";
    render();
  },
  async plan(form) {
    const body = Object.fromEntries(form);
    await api(`/api/plans/${body.id}`, { method: "PATCH", body: JSON.stringify({ ...body, priceUgx: Number(body.priceUgx), deviceLimit: Number(body.deviceLimit), supportHours: Number(body.supportHours), responseTargetHours: Number(body.responseTargetHours) }) });
    state.notice = "Plan saved.";
    render();
  },
  async activate(form) {
    await api(`/api/organizations/${state.params.id}/subscription`, { method: "POST", body: JSON.stringify({ planId: Number(Object.fromEntries(form).planId) }) });
    state.notice = "Subscription activated from a confirmed payment.";
    render();
  },
  async maintenance(form) { await api("/api/maintenance", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); state.notice = "Maintenance record saved."; render(); },
  async schedule(form) {
    const body = Object.fromEntries(form);
    if (body.intervalDays) body.intervalDays = Number(body.intervalDays);
    await api("/api/schedules", { method: "POST", body: JSON.stringify(body) });
    state.notice = "Schedule saved.";
    render();
  },
  async note(form) {
    await api(`/api/tickets/${state.params.id}/notes`, { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    state.notice = "Note added.";
    render();
  },
  async "ticket-update"(form) {
    const body = Object.fromEntries(form);
    body.assignedTo = body.assignedTo ? Number(body.assignedTo) : null;
    await api(`/api/tickets/${state.params.id}`, { method: "PATCH", body: JSON.stringify(body) });
    state.notice = "Ticket saved.";
    render();
  },
};

function enter(data) {
  state.user = data.user;
  csrf = data.csrfToken;
  state.view = "dashboard";
  state.error = "";
  state.notice = "";
  state.query = {};
  state.page = 1;
  render();
}

app.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !forms[form.dataset.form]) return;
  event.preventDefault();
  const button = form.querySelector("button[type=submit]");
  if (button) button.disabled = true;
  state.error = "";
  try {
    await forms[form.dataset.form](new FormData(form));
  } catch (error) {
    setError(error.message);
    if (button) button.disabled = false;
  }
});

app.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "menu") {
    document.getElementById("sidebar").classList.toggle("open");
    return;
  }
  if (action === "show-register") { state.view = "register"; state.error = ""; render(); return; }
  if (action === "show-login") { state.view = "login"; state.error = ""; render(); return; }
  if (action === "nav" || action === "open") {
    state.view = button.dataset.nav || button.dataset.view;
    state.params = { id: button.dataset.id };
    state.query = {};
    state.page = 1;
    state.error = "";
    state.notice = "";
    render();
    return;
  }
  if (action === "page") {
    state.page = Number(button.dataset.page);
    state.error = "";
    render();
    return;
  }
  if (action === "logout") {
    await api("/api/logout", { method: "POST", body: "{}" });
    state.user = null;
    csrf = "";
    state.view = "login";
    state.notice = "";
    render();
    return;
  }
  try {
    if (action === "consent") await api(`/api/devices/${button.dataset.id}/consent`, { method: "POST", body: "{}" });
    if (action === "check-device") {
      const checked = await api(`/api/devices/${button.dataset.id}/check`, { method: "POST", body: "{}" });
      state.notice = checked.device.reachability === "online" ? "Device is online." : "Device is offline.";
      render();
      return;
    }
    if (action === "confirm-payment") await api(`/api/payments/${button.dataset.id}/confirm`, { method: "POST", body: "{}" });
    if (action === "read") await api(`/api/notifications/${button.dataset.id}/read`, { method: "POST", body: "{}" });
    state.notice = "Saved.";
    render();
  } catch (error) {
    setError(error.message);
  }
});

const health = await api("/api/health");
state.config = await api("/api/public-config");
state.needsSetup = health.needsSetup;
if (health.needsSetup) state.view = "setup";
else {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    csrf = me.csrfToken;
    state.view = "dashboard";
  } catch {
    state.view = "login";
  }
}
render();
