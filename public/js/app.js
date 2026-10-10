import { api, button, clear, currentQuery, errorBox, h, icon, pageHeader, state, toast } from "./core.js";
import { accountPage, auditPage, myOrganizationPage, notificationsPage, organizationDetailPage, organizationsPage, reportsPage, settingsPage, teamPage } from "./pages-admin.js";
import { deviceDetailPage, devicesPage, maintenancePage } from "./pages-assets.js";
import { invitePage, loginPage, registerPage, setupPage } from "./pages-auth.js";
import { billingPage } from "./pages-billing.js";
import { dashboardPage, ticketDetailPage, ticketsPage } from "./pages-main.js";
import { incidentDetailPage, incidentsPage, monitorDetailPage, monitoringPage, statusPage, windowsPage } from "./pages-ops.js";

const root = document.getElementById("app");
const STAFF = ["admin", "technician"];
const ALL = ["admin", "technician", "customer_admin", "customer_user"];

const NAV = [
  { path: "dashboard", label: "Dashboard", icon: "dashboard", roles: ALL },
  { path: "tickets", label: "Tickets", icon: "ticket", roles: ALL },
  { path: "organizations", label: "Organizations", icon: "building", roles: STAFF },
  { path: "devices", label: "Devices", icon: "device", roles: ALL },
  { path: "maintenance", label: "Maintenance", icon: "wrench", roles: ["admin", "technician", "customer_admin"] },
  { path: "monitoring", label: "Monitoring", icon: "pulse", roles: STAFF },
  { path: "incidents", label: "Incidents", icon: "alert", roles: STAFF },
  { path: "status", label: "Service status", icon: "pulse", roles: ["customer_admin", "customer_user"] },
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
  organizations: STAFF, monitoring: STAFF, "maintenance-windows": STAFF, incidents: ALL, team: ["admin"], settings: ["admin"],
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
        location.hash = "#/login";
        boot();
      }, { kind: "ghost small block", iconName: "logout" })));
  const toggle = h("button", { type: "button", class: "icon-btn menu-btn", "aria-label": "Open menu", onclick: () => document.body.classList.toggle("nav-open") }, icon("menu"));
  const topbar = h("header", { class: "topbar" }, toggle, h("div", { class: "topbar-title" }, state.org ? state.org.name : "OSVIA TECHNOLOGIES"), h("div", { class: "spacer" }), themeBtn, bell, h("a", { href: "#/account", class: "icon-btn", title: "Account", "aria-label": "Account" }, icon("user")));
  const scrim = h("div", { class: "scrim", onclick: () => document.body.classList.remove("nav-open") });
  clear(root, h("a", { href: "#main", class: "skip" }, "Skip to content"), h("div", { class: "layout" }, sidebar, scrim, h("div", { class: "content" }, topbar, main)));
  for (const item of NAV.filter((n) => n.roles.includes(state.me.role))) {
    nav.append(h("a", { href: `#/${item.path}`, dataset: { path: item.path } }, icon(item.icon), h("span", {}, item.label)));
  }
  shell = { main, nav, bell };
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

async function route() {
  for (const open of document.querySelectorAll("dialog.modal")) open.remove();
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
  if (state.mustEnrollMfa && path !== "account" && path !== "notifications") {
    location.hash = "#/account";
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
  } catch (error) {
    clear(shell.main, errorBox(error, route));
  }
  shell.main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
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
    if (me.mustEnrollMfa) toast("Turn on two-factor authentication to unlock staff tools.", "warn");
  } catch {
    state.me = null;
  }
  await route();
  refreshUnread();
}

window.addEventListener("hashchange", () => {
  if (location.hash === "#main") return;
  route();
});
document.addEventListener("osvia:unread", refreshUnread);
setInterval(refreshUnread, 60000);
boot();
