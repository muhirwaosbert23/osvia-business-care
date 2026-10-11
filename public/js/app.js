import { api, button, clear, currentQuery, errorBox, h, icon, pageHeader, state, toast } from "./core.js";
import { accountPage, auditPage, myOrganizationPage, notificationsPage, organizationDetailPage, organizationsPage, reportsPage, settingsPage, teamPage } from "./pages-admin.js";
import { deviceDetailPage, devicesPage, maintenancePage, mapPage, remoteDeskPage } from "./pages-assets.js";
import { invitePage, loginPage, registerPage, setupPage } from "./pages-auth.js";
import { billingPage } from "./pages-billing.js";
import { dashboardPage, newTicketDialog, ticketDetailPage, ticketsPage } from "./pages-main.js";
import { mountPalette, openPalette, rememberVisit } from "./palette.js";
import { incidentDetailPage, incidentsPage, monitorDetailPage, monitoringPage, statusPage, windowsPage } from "./pages-ops.js";

const root = document.getElementById("app");
const STAFF = ["admin", "technician"];
const ALL = ["admin", "technician", "customer_admin", "customer_user"];

const NAV = [
  { path: "dashboard", label: "Dashboard", icon: "dashboard", roles: ALL },
  { path: "tickets", label: "Tickets", icon: "ticket", roles: ALL },
  { path: "organizations", label: "Organizations", icon: "building", roles: STAFF },
  { path: "devices", label: "Devices", icon: "device", roles: ALL },
  { path: "map", label: "Map", icon: "map", roles: STAFF },
  { path: "remote", label: "Remote desk", icon: "remote", roles: STAFF },
  { path: "maintenance", label: "Maintenance", icon: "wrench", roles: ["admin", "technician", "customer_admin"] },
  { path: "monitoring", label: "Monitoring", icon: "pulse", roles: STAFF },
  { path: "incidents", label: "Incidents", icon: "alert", roles: STAFF },
  { path: "status", label: "Websites & status", icon: "pulse", roles: ["customer_admin", "customer_user"] },
  { path: "billing", label: "Billing", icon: "money", roles: ["admin", "customer_admin"] },
  { path: "reports", label: "Reports", icon: "chart", roles: ["admin", "technician", "customer_admin"] },
  { path: "organization", label: "Organization", icon: "building", roles: ["customer_admin"] },
  { path: "team", label: "OSVIA team", icon: "users", roles: ["admin"] },
  { path: "audit", label: "Audit log", icon: "shield", roles: ["admin", "customer_admin"] },
  { path: "settings", label: "Settings", icon: "settings", roles: ["admin"] },
];

const ROUTES = [
  ["dashboard", dashboardPage],
  ["tickets", ticketsPage],
  ["tickets/:id", ticketDetailPage],
  ["organizations", organizationsPage],
  ["organizations/:id", organizationDetailPage],
  ["organization", myOrganizationPage],
  ["devices", devicesPage],
  ["devices/:id", deviceDetailPage],
  ["map", mapPage],
  ["remote", remoteDeskPage],
  ["maintenance", maintenancePage],
  ["monitoring", monitoringPage],
  ["monitoring/:id", monitorDetailPage],
  ["maintenance-windows", windowsPage],
  ["incidents", incidentsPage],
  ["incidents/:id", incidentDetailPage],
  ["status", statusPage],
  ["billing", billingPage],
  ["reports", reportsPage],
  ["team", teamPage],
  ["audit", auditPage],
  ["settings", settingsPage],
  ["account", accountPage],
  ["notifications", notificationsPage],
];

const ROUTE_ROLES = {
  organizations: STAFF, map: STAFF, remote: STAFF, "maintenance-windows": STAFF, incidents: ALL, team: ["admin"], settings: ["admin"],
  billing: ["admin", "customer_admin"], reports: ["admin", "technician", "customer_admin"], audit: ["admin", "customer_admin"],
  organization: ["customer_admin"], maintenance: ["admin", "technician", "customer_admin"],
};

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("osvia-theme", theme);
}

applyTheme(localStorage.getItem("osvia-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

let shell = null;

function buildShell() {
  const main = h("main", { id: "main", class: "main", tabindex: "-1" });
  const nav = h("nav", { class: "nav", "aria-label": "Main" });
  const bell = h("a", { href: "#/notifications", class: "icon-btn", title: "Notifications", "aria-label": "Notifications" }, icon("bell"), h("span", { class: "count hidden" }));
  const live = h("span", { class: "live-pill", title: "Connecting to live checks…", "aria-live": "polite" }, h("i", { class: "live-dot" }), "Live");
  const themeBtn = h("button", { type: "button", class: "icon-btn", title: "Switch light or dark theme", "aria-label": "Switch theme", onclick: () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    clear(themeBtn, icon(document.documentElement.dataset.theme === "dark" ? "sun" : "moon"));
  } }, icon(document.documentElement.dataset.theme === "dark" ? "sun" : "moon"));
  const sidebar = h("aside", { class: "sidebar" },
    h("a", { href: "#/dashboard", class: "brand" }, h("img", { src: "/osvia-logo.jpeg", alt: "OSVIA TECH" }), h("span", {}, "Business Care")),
    nav,
    h("div", { class: "sidebar-foot" },
      h("a", { href: "#/account", class: "me" }, h("span", { class: "avatar" }, initials(state.me.name)), h("span", {}, h("strong", {}, state.me.name), h("small", {}, state.me.roleLabel))),
      button("Sign out", async () => {
        await api("POST", "/api/logout").catch(() => {});
        state.me = null;
        stopLive();
        location.hash = "#/login";
        boot();
      }, { kind: "ghost small block", iconName: "logout" })));
  const toggle = h("button", { type: "button", class: "icon-btn menu-btn", "aria-label": "Open menu", onclick: () => document.body.classList.toggle("nav-open") }, icon("menu"));
  const finder = h("button", { type: "button", class: "finder", title: "Search or jump to a page (Ctrl+K)", onclick: () => openPalette() }, icon("search"), h("span", {}, "Search"), h("kbd", {}, "Ctrl K"));
  const topbar = h("header", { class: "topbar" }, toggle, h("div", { class: "topbar-title" }, state.org ? state.org.name : "OSVIA TECHNOLOGIES"), finder, live, h("div", { class: "spacer" }), themeBtn, bell, h("a", { href: "#/account", class: "icon-btn", title: "Account", "aria-label": "Account" }, icon("user")));
  const scrim = h("div", { class: "scrim", onclick: () => document.body.classList.remove("nav-open") });
  clear(root, h("a", { href: "#main", class: "skip" }, "Skip to content"), h("div", { class: "layout" }, sidebar, scrim, h("div", { class: "content" }, topbar, main)));
  for (const item of NAV.filter((n) => n.roles.includes(state.me.role))) {
    const locked = state.mustEnrollMfa && item.path !== "dashboard";
    nav.append(h("a", { href: `#/${item.path}`, dataset: { path: item.path }, class: locked ? "locked" : null, title: locked ? "Turn on two-factor authentication to unlock" : null },
      icon(item.icon), h("span", {}, item.label), locked ? icon("lock", "icon tiny lock-mark") : null));
  }
  shell = { main, nav, bell, live };
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");
}

async function refreshUnread() {
  if (!shell || !state.me) return;
  try {
    const data = await api("GET", "/api/notifications?unread=1&limit=1");
    state.unread = data.unread;
    const badgeEl = shell.bell.querySelector(".count");
    badgeEl.textContent = data.unread > 99 ? "99+" : String(data.unread);
    badgeEl.classList.toggle("hidden", !data.unread);
  } catch {
    /* ignore polling failures */
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path] = raw.split("?");
  return path || "dashboard";
}

function matchRoute(path) {
  for (const [pattern, handler] of ROUTES) {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:([a-z]+)/g, (_, k) => {
      keys.push(k);
      return "(\\d+)";
    })}$`);
    const m = regex.exec(path);
    if (m) return { handler, id: m[1] ? Number(m[1]) : null, base: pattern.split("/")[0] };
  }
  return null;
}

async function route({ silent = false } = {}) {
  if (!silent) {
    for (const open of document.querySelectorAll("dialog.modal")) open.remove();
  } else if (document.querySelector("dialog.modal")) {
    return;
  }
  const path = parseHash();
  if (path.startsWith("invite/")) return invitePage(root, path.slice(7), boot);
  if (!state.me) {
    if (path === "register") return registerPage(root);
    return loginPage(root, boot);
  }
  if (path === "login" || path === "register") {
    location.hash = "#/dashboard";
    return;
  }
  if (!shell) buildShell();
  document.body.classList.remove("nav-open");
  const match = matchRoute(path);
  for (const a of shell.nav.querySelectorAll("a")) {
    const active = path === a.dataset.path || path.startsWith(`${a.dataset.path}/`);
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (state.mustEnrollMfa && !["dashboard", "account", "notifications"].includes(path)) {
    location.hash = "#/dashboard";
    return;
  }
  if (!match) {
    clear(shell.main, pageHeader("Page not found"), h("p", {}, h("a", { href: "#/dashboard" }, "Go to the dashboard")));
    return;
  }
  const allowed = ROUTE_ROLES[match.base];
  if (allowed && !allowed.includes(state.me.role)) {
    clear(shell.main, pageHeader("Not available"), h("p", { class: "muted" }, "Your role does not include this page."));
    return;
  }
  try {
    await (match.id ? match.handler(shell.main, match.id) : match.handler(shell.main, currentQuery()));
    const title = shell.main.querySelector("h1")?.textContent?.trim();
    if (title && title !== "Page not found" && title !== "Not available") {
      rememberVisit({ href: location.hash, label: title, hint: NAV.find((item) => item.path === match.base)?.label || "Page" });
    }
  } catch (error) {
    clear(shell.main, errorBox(error, route));
  }
  if (!silent) {
    shell.main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

let liveSource = null;
let liveRetry = 0;

function setLiveState(mode, title) {
  if (!shell?.live) return;
  shell.live.className = `live-pill ${mode}`;
  shell.live.title = title;
}

function livePath() {
  const path = parseHash();
  return ["dashboard", "devices", "status", "monitoring", "incidents"].some((p) => path === p || path.startsWith(`${p}/`));
}

function connectLive() {
  if (!state.me || liveSource) return;
  const source = new EventSource("/api/events");
  liveSource = source;
  source.addEventListener("hello", () => {
    liveRetry = 0;
    setLiveState("on", "Live. Device checks run every 15 seconds and this page updates when something changes.");
  });
  source.addEventListener("device.status", (event) => {
    const data = JSON.parse(event.data);
    toast(data.status === "offline" ? `${data.name} went offline` : `${data.name} is back online`, data.status === "offline" ? "error" : "ok");
    document.dispatchEvent(new CustomEvent("osvia:unread"));
    if (livePath()) route({ silent: true });
  });
  source.addEventListener("notification", (event) => {
    const data = JSON.parse(event.data);
    if (data.kind !== "device") toast(data.title);
    document.dispatchEvent(new CustomEvent("osvia:unread"));
    if (livePath() && data.kind !== "device") route({ silent: true });
  });
  source.onerror = () => {
    setLiveState("off", "Live connection lost. Reconnecting…");
    source.close();
    liveSource = null;
    liveRetry = Math.min(liveRetry + 1, 6);
    setTimeout(connectLive, 2000 * liveRetry);
  };
}

function stopLive() {
  liveSource?.close();
  liveSource = null;
}

async function boot() {
  shell = null;
  try {
    state.config = await api("GET", "/api/public-config");
    const health = await api("GET", "/api/health");
    if (health.needsSetup) {
      setupPage(root, boot, health.setupTokenRequired);
      return;
    }
  } catch (error) {
    clear(root, h("div", { class: "boot-error" }, errorBox(error, boot)));
    return;
  }
  try {
    const me = await api("GET", "/api/me");
    state.me = me.user;
    state.org = me.organization;
    state.mustEnrollMfa = me.mustEnrollMfa;
  } catch {
    state.me = null;
    stopLive();
  }
  await route();
  refreshUnread();
  if (state.me) connectLive();
}

window.addEventListener("hashchange", () => {
  if (location.hash === "#main") return;
  route();
});
document.addEventListener("osvia:unread", refreshUnread);
setInterval(refreshUnread, 60000);
mountPalette({
  pages() {
    const pages = NAV.filter((item) => item.roles.includes(state.me.role)).map((item) => ({ href: `#/${item.path}`, label: item.label, hint: "Go to page" }));
    pages.push({ href: "#/account", label: "Account", hint: "Go to page" }, { href: "#/notifications", label: "Notifications", hint: "Go to page" });
    if (state.mustEnrollMfa) return pages.filter((item) => ["#/dashboard", "#/account", "#/notifications"].includes(item.href));
    return pages;
  },
  actions() {
    const staff = STAFF.includes(state.me.role);
    const actions = [];
    if (staff || state.org?.status === "active") actions.push({ label: "New ticket", hint: "Open the ticket form", run: () => newTicketDialog() });
    if (staff) {
      actions.push({ label: "Tickets assigned to me", hint: "Tickets", href: "#/tickets?assigned=me" });
      actions.push({ label: "Unassigned tickets", hint: "Tickets", href: "#/tickets?assigned=none" });
    }
    actions.push({ label: "SLA breached tickets", hint: "Tickets", href: "#/tickets?breached=1" });
    actions.push({
      label: "Copy link to this page",
      hint: location.hash || "#/dashboard",
      run: async () => {
        await navigator.clipboard.writeText(location.href);
        toast("Link copied.");
      },
    });
    return actions;
  },
});
boot();
