export const state = { me: null, org: null, csrf: "", config: {}, unread: 0 };

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, url, body, { raw = false, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, credentials: "same-origin" };
  if (method !== "GET" && state.csrf) init.headers["X-CSRF-Token"] = state.csrf;
  if (raw) init.body = body;
  else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, "The portal cannot be reached. Check your connection.");
  }
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && state.me && !url.startsWith("/api/login")) {
      state.me = null;
      location.hash = "#/login";
    }
    throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`);
  }
  if (data?.csrfToken) state.csrf = data.csrfToken;
  return data;
}

export async function download(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
    throw new ApiError(res.status, data?.error || "The download failed.");
  }
  const disposition = res.headers.get("content-disposition") || "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] || "download";
  const blob = await res.blob();
  const link = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 1000);
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = Boolean(value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

const ICONS = {
  dashboard: "M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z",
  ticket: "M4 4h16v5a3 3 0 0 0 0 6v5H4v-5a3 3 0 0 0 0-6zm5 3v10m6-10v10",
  building: "M4 21V5l8-3 8 3v16M9 21v-4h6v4M8 8h2m4 0h2M8 12h2m4 0h2",
  device: "M3 5h18v11H3zM8 20h8m-4-4v4",
  wrench: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  alert: "M12 3 2 21h20zM12 10v5m0 3v.01",
  money: "M3 6h18v12H3zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M6 9v.01M18 15v.01",
  chart: "M4 20V10m6 10V4m6 16v-7m4 7H2",
  shield: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z",
  users: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6m13 9v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9",
  plus: "M12 5v14M5 12h14",
  menu: "M3 6h18M3 12h18M3 18h18",
  close: "M18 6 6 18M6 6l12 12",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16m10 2-4.4-4.4",
  refresh: "M23 4v6h-6M1 20v-6h6m14.5-5A9 9 0 0 0 5.6 5.6L1 10m22 4-4.6 4.4A9 9 0 0 1 3.5 15",
  check: "M20 6 9 17l-5-5",
  monitor: "M2 4h20v12H2zM8 20h8M12 16v4M6 12l3-3 2 2 4-4 3 3",
  remote: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  clip: "M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7L9.4 17.5a2 2 0 0 1-2.8-2.8l8.5-8.5",
  calendar: "M3 4h18v18H3zM16 2v4M8 2v4M3 10h18",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  smartphone: "M7 2h10v20H7zM11 18h2",
  map: "M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2zm0 0v16m6-14v16",
};

export function icon(name, cls = "icon") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name] || ICONS.dashboard);
  svg.append(path);
  return svg;
}

export function button(label, onClick, { kind = "", iconName = null, type = "button", disabled = false, title = null } = {}) {
  const btn = h("button", { type, class: `btn ${kind}`.trim(), disabled, title }, iconName ? icon(iconName) : null, label ? h("span", {}, label) : null);
  if (onClick) {
    btn.addEventListener("click", async (event) => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await onClick(event);
      } catch (error) {
        toast(error.message, "error");
      } finally {
        if (btn.isConnected) btn.disabled = false;
      }
    });
  }
  return btn;
}

let toastHost = null;
export function toast(message, kind = "ok") {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const el = h("div", { class: `toast ${kind}` }, message);
  toastHost.append(el);
  setTimeout(() => el.classList.add("leaving"), 4200);
  setTimeout(() => el.remove(), 4700);
}

export function dialog(title, body, { actions = [], wide = false } = {}) {
  const el = h("dialog", { class: `modal ${wide ? "wide" : ""}`, "aria-label": title });
  const close = () => {
    el.close();
    el.remove();
  };
  append(el, [
    h("header", { class: "modal-head" }, h("h2", {}, title), button("", close, { kind: "ghost icon-only", iconName: "close", title: "Close" })),
    h("div", { class: "modal-body" }, body),
    actions.length ? h("footer", { class: "modal-foot" }, actions.map((a) => (typeof a === "function" ? a(close) : a))) : null,
  ]);
  el.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  document.body.append(el);
  el.showModal();
  return { el, close };
}

export function confirmDialog(title, message, { confirmLabel = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value, close) => {
      done = true;
      close();
      resolve(value);
    };
    const d = dialog(title, h("p", {}, message), {
      actions: [
        (close) => button("Cancel", () => finish(false, close), { kind: "ghost" }),
        (close) => button(confirmLabel, () => finish(true, close), { kind: danger ? "danger" : "primary" }),
      ],
    });
    d.el.addEventListener("close", () => {
      if (!done) resolve(false);
    });
  });
}

export function formDialog(title, fields, onSubmit, { submitLabel = "Save", wide = false, intro = null } = {}) {
  const form = buildForm(fields);
  let d;
  const submit = button(submitLabel, null, { kind: "primary", type: "submit" });
  form.el.append(h("div", { class: "form-error", role: "alert" }));
  form.el.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    form.el.querySelector(".form-error").textContent = "";
    try {
      await onSubmit(form.values(), d.close);
    } catch (error) {
      form.el.querySelector(".form-error").textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  const cancel = button("Cancel", () => d.close(), { kind: "ghost" });
  form.el.append(h("div", { class: "modal-foot inline" }, cancel, submit));
  d = dialog(title, [intro ? h("p", { class: "muted" }, intro) : null, form.el], { wide });
  form.el.querySelector("input, select, textarea")?.focus();
  return d;
}

export function buildForm(fields) {
  const el = h("form", { class: "form", novalidate: true });
  const inputs = {};
  for (const f of fields) {
    if (f.type === "heading") {
      el.append(h("h3", { class: "form-heading" }, f.label));
      continue;
    }
    if (f.type === "note") {
      el.append(h("p", { class: "muted small" }, f.label));
      continue;
    }
    let input;
    const id = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
    if (f.type === "select") {
      input = h("select", { id, name: f.name, required: f.required }, (f.options || []).map(([value, label]) => h("option", { value }, label)));
      if (f.value !== undefined && f.value !== null) input.value = String(f.value);
    } else if (f.type === "textarea") {
      input = h("textarea", { id, name: f.name, rows: f.rows || 4, required: f.required, maxlength: f.max, placeholder: f.placeholder });
      input.value = f.value ?? "";
    } else if (f.type === "checkbox") {
      input = h("input", { id, name: f.name, type: "checkbox", checked: Boolean(f.value) });
    } else {
      input = h("input", { id, name: f.name, type: f.type || "text", required: f.required, maxlength: f.max, min: f.min, max: f.maxValue, step: f.step, placeholder: f.placeholder, autocomplete: f.autocomplete || "off", inputmode: f.inputmode });
      input.value = f.value ?? "";
    }
    inputs[f.name] = { input, f };
    const label = h("label", { for: id }, f.label, f.required ? h("span", { class: "req", "aria-hidden": "true" }, " *") : null);
    el.append(f.type === "checkbox" ? h("div", { class: "field check" }, input, label, f.help ? h("small", {}, f.help) : null) : h("div", { class: `field ${f.full ? "full" : ""}` }, label, input, f.help ? h("small", {}, f.help) : null));
  }
  return {
    el,
    inputs,
    values() {
      const out = {};
      for (const [name, { input, f }] of Object.entries(inputs)) {
        if (f.type === "checkbox") out[name] = input.checked;
        else if (f.type === "number") out[name] = input.value === "" ? null : Number(input.value);
        else if (f.type === "datetime-local") out[name] = input.value ? new Date(input.value).toISOString() : "";
        else out[name] = input.value.trim();
      }
      return out;
    },
  };
}

const LABELS = {
  new: "New", open: "Open", in_progress: "In progress", pending_customer: "Waiting on customer", resolved: "Resolved", closed: "Closed",
  online: "Online", offline: "Offline", unknown: "Unknown", up: "Up", down: "Down", stale: "Stale", paused: "Paused",
  pending: "Pending", active: "Active", suspended: "Suspended", unpaid: "Unpaid", past_due: "Past due", cancelled: "Cancelled",
  verified: "Verified", rejected: "Rejected", issued: "Issued", paid: "Paid", void: "Void",
  met: "Met", breached: "Breached", not_applicable: "No target", not_offered: "Not offered",
  ok: "Healthy", error: "Error", not_configured: "Not configured", requested: "Requested",
  low: "Low", normal: "Normal", high: "High", urgent: "Urgent", minor: "Minor", major: "Major", critical: "Critical",
};
const TONES = {
  new: "info", open: "info", in_progress: "accent", pending_customer: "warn", resolved: "ok", closed: "muted",
  online: "ok", up: "ok", offline: "bad", down: "bad", unknown: "muted", stale: "warn", paused: "muted",
  pending: "warn", active: "ok", suspended: "bad", unpaid: "warn", past_due: "bad", cancelled: "muted",
  verified: "ok", rejected: "bad", issued: "info", paid: "ok", void: "muted",
  met: "ok", breached: "bad", not_applicable: "muted", not_offered: "muted",
  ok: "ok", error: "bad", not_configured: "muted", requested: "info",
  low: "muted", normal: "info", high: "warn", urgent: "bad", minor: "warn", major: "bad", critical: "bad",
};

export function label(value) {
  return LABELS[value] || String(value ?? "").replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function badge(value, text = null) {
  return h("span", { class: `badge ${TONES[value] || "muted"}` }, text ?? label(value));
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Africa/Kampala" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Kampala" });

export function fmtDate(value) {
  if (!value) return "—";
  const d = value.length === 10 ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}

export function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : dateTimeFmt.format(d);
}

export function fmtRelative(value) {
  if (!value) return "—";
  const diff = Date.parse(value) - Date.now();
  const abs = Math.abs(diff);
  const units = [["day", 86400000], ["hour", 3600000], ["minute", 60000]];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === "minute") return rtf.format(Math.round(diff / ms), unit);
  }
  return "—";
}

export function money(amount, currency = "UGX") {
  if (amount === null || amount === undefined) return "—";
  return `${currency} ${Number(amount).toLocaleString("en-US")}`;
}

export function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function skeleton(rows = 4) {
  return h("div", { class: "skeleton-wrap", "aria-busy": "true", "aria-label": "Loading" }, Array.from({ length: rows }, () => h("div", { class: "skeleton" })));
}

export function empty(title, text = "", action = null) {
  return h("div", { class: "empty" }, h("strong", {}, title), text ? h("p", {}, text) : null, action);
}

export function errorBox(error, retry) {
  return h("div", { class: "error-box", role: "alert" }, h("strong", {}, "This could not be loaded."), h("p", {}, error.message), retry ? button("Try again", retry, { kind: "ghost", iconName: "refresh" }) : null);
}

export function card(title, body, { actions = null, cls = "" } = {}) {
  return h("section", { class: `card ${cls}` }, title || actions ? h("header", { class: "card-head" }, title ? h("h2", {}, title) : null, actions ? h("div", { class: "card-actions" }, actions) : null) : null, body);
}

export function stat(labelText, value, { tone = "", hint = "", href = null } = {}) {
  const inner = [h("span", { class: "stat-label" }, labelText), h("span", { class: "stat-value" }, value ?? "—"), hint ? h("span", { class: "stat-hint" }, hint) : null];
  return href ? h("a", { class: `stat ${tone}`, href }, inner) : h("div", { class: `stat ${tone}` }, inner);
}

export function definitionList(pairs) {
  return h("dl", { class: "deflist" }, pairs.filter(Boolean).map(([k, v]) => [h("dt", {}, k), h("dd", {}, v === null || v === undefined || v === "" ? "—" : v)]));
}

export function currentQuery() {
  const hash = location.hash.slice(2);
  const index = hash.indexOf("?");
  return new URLSearchParams(index >= 0 ? hash.slice(index + 1) : "");
}

export function dataTable({ columns, load, filters = [], searchPlaceholder = "Search", defaultSort = null, rowHref = null, toolbar = [], emptyText = "Nothing here yet.", pageSize = 20 }) {
  const params = { page: 1, sort: defaultSort?.key || "", dir: defaultSort?.dir || "desc", q: "", ...Object.fromEntries(filters.map((f) => [f.name, f.value ?? ""])) };
  const tbody = h("tbody");
  const pager = h("div", { class: "pager" });
  const info = h("span", { class: "muted small" });
  const wrap = h("div", { class: "table-card" });
  const headRow = h("tr");
  let searchTimer = null;

  const search = searchPlaceholder ? h("input", { type: "search", class: "search", placeholder: searchPlaceholder, "aria-label": searchPlaceholder, oninput: (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      params.q = e.target.value.trim();
      params.page = 1;
      refresh();
    }, 300);
  } }) : null;

  const filterEls = filters.map((f) => {
    const select = h("select", { "aria-label": f.label, onchange: (e) => {
      params[f.name] = e.target.value;
      params.page = 1;
      refresh();
    } }, f.options.map(([value, text]) => h("option", { value }, text)));
    select.value = params[f.name];
    return select;
  });

  for (const col of columns) {
    const th = h("th", { scope: "col", class: col.cls || "" });
    if (col.sort) {
      const b = h("button", { type: "button", class: "th-sort", onclick: () => {
        if (params.sort === col.sort) params.dir = params.dir === "asc" ? "desc" : "asc";
        else {
          params.sort = col.sort;
          params.dir = "asc";
        }
        refresh();
      } }, col.label, h("span", { class: "sort-mark" }));
      th.append(b);
      col._th = th;
    } else th.textContent = col.label;
    headRow.append(th);
  }

  wrap.append(
    h("div", { class: "table-toolbar" }, search, filterEls, h("div", { class: "spacer" }), toolbar),
    h("div", { class: "table-scroll" }, h("table", { class: "table" }, h("thead", {}, headRow), tbody)),
    h("div", { class: "table-foot" }, info, pager),
  );

  async function refresh() {
    for (const col of columns) {
      if (!col._th) continue;
      col._th.setAttribute("aria-sort", params.sort === col.sort ? (params.dir === "asc" ? "ascending" : "descending") : "none");
    }
    clear(tbody, h("tr", {}, h("td", { colspan: columns.length }, skeleton(3))));
    try {
      const query = new URLSearchParams({ page: params.page, limit: pageSize });
      for (const [key, value] of Object.entries(params)) if (value && key !== "page") query.set(key, value);
      const data = await load(query);
      const items = data.items || [];
      if (!items.length) clear(tbody, h("tr", {}, h("td", { colspan: columns.length }, empty(emptyText))));
      else {
        clear(tbody, items.map((item) => {
          const tr = h("tr", { class: rowHref ? "clickable" : "" }, columns.map((col) => h("td", { class: col.cls || "", "data-label": col.label }, col.render ? col.render(item) : item[col.key] ?? "—")));
          if (rowHref) {
            tr.tabIndex = 0;
            const go = (event) => {
              if (event.target.closest("button, a, input, select")) return;
              location.hash = rowHref(item);
            };
            tr.addEventListener("click", go);
            tr.addEventListener("keydown", (e) => e.key === "Enter" && go(e));
          }
          return tr;
        }));
      }
      const total = data.total ?? items.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      info.textContent = total ? `${(params.page - 1) * pageSize + 1}–${Math.min(params.page * pageSize, total)} of ${total}` : "";
      clear(pager,
        button("Previous", () => { params.page -= 1; return refresh(); }, { kind: "ghost small", disabled: params.page <= 1 }),
        h("span", { class: "small" }, `Page ${params.page} of ${pages}`),
        button("Next", () => { params.page += 1; return refresh(); }, { kind: "ghost small", disabled: params.page >= pages }));
    } catch (error) {
      clear(tbody, h("tr", {}, h("td", { colspan: columns.length }, errorBox(error, refresh))));
    }
  }

  refresh();
  return { el: wrap, refresh, params };
}

export function copyLinkButton() {
  return button("Copy link", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast("Link copied.");
    } catch {
      toast("Copy failed. Copy the address from the browser bar.", "error");
    }
  }, { kind: "ghost", iconName: "clip" });
}

export function pageHeader(title, subtitle = "", actions = []) {
  return h("header", { class: "page-head" }, h("div", {}, h("h1", {}, title), subtitle ? h("p", { class: "muted" }, subtitle) : null), h("div", { class: "page-actions" }, actions));
}

export function isStaff() {
  return state.me && ["admin", "technician"].includes(state.me.role);
}

export function isRole(...roles) {
  return state.me && roles.includes(state.me.role);
}

export async function orgOptions(includeAll = false) {
  const data = await api("GET", "/api/organizations?limit=100&sort=name&dir=asc");
  const list = data.items.map((o) => [String(o.id), o.name]);
  return includeAll ? [["", "All organizations"], ...list] : list;
}

export async function staffOptions() {
  const data = await api("GET", "/api/users?role=staff&limit=100");
  return data.items.filter((u) => u.active).map((u) => [String(u.id), u.name]);
}

export function enumOptions(values, blank = null) {
  const list = values.map((v) => [v, label(v)]);
  return blank ? [["", blank], ...list] : list;
}

export const TICKET_STATUSES = ["new", "open", "in_progress", "pending_customer", "resolved", "closed"];
export const PRIORITIES = ["low", "normal", "high", "urgent"];
export const CATEGORIES = ["hardware", "software", "network", "email", "printer", "security", "account_access", "other"];
export const IMPACTS = ["single_user", "team", "organization"];
export const ASSET_TYPES = ["computer", "laptop", "server", "printer", "network", "phone", "other"];
export const CONDITIONS = ["unknown", "good", "fair", "poor"];
export const OPERATIONAL = ["in_service", "in_repair", "spare", "retired"];
export const PAYMENT_METHODS = ["mobile_money_manual", "bank_transfer", "cash", "cheque", "other"];
