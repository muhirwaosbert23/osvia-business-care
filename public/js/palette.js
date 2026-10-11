import { api, clear, h, icon, state, toast } from "./core.js";

const RECENT_KEY = "osvia-recent";

let getPages = () => [];
let getActions = () => [];
let dialogEl = null;
let inputEl = null;
let listEl = null;
let items = [];
let active = 0;
let request = 0;
let timer = null;

function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.href && item.label).slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function rememberVisit(item) {
  if (!item?.href || !item.label || item.href === "#/dashboard") return;
  const next = [item, ...readRecent().filter((entry) => entry.href !== item.href)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next.map((entry) => ({ href: entry.href, label: entry.label, hint: entry.hint || "" }))));
}

export function openPalette() {
  if (!state.me || document.querySelector("dialog.modal")) return;
  ensure();
  if (dialogEl.open) {
    dialogEl.close();
    return;
  }
  inputEl.value = "";
  active = 0;
  dialogEl.showModal();
  render([]);
  inputEl.focus();
}

export function mountPalette({ pages, actions }) {
  getPages = pages;
  getActions = actions;
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
    }
  });
  window.addEventListener("hashchange", () => {
    if (dialogEl?.open) dialogEl.close();
  });
}

function ensure() {
  if (dialogEl) return;
  inputEl = h("input", {
    type: "search",
    placeholder: "Tickets, devices, organizations, or pages",
    "aria-label": "Quick find",
    autocomplete: "off",
    spellcheck: "false",
  });
  listEl = h("div", { class: "palette-list", role: "listbox", "aria-label": "Results" });
  dialogEl = h("dialog", { class: "palette", "aria-label": "Quick find" },
    h("div", { class: "palette-search" }, icon("search"), inputEl, h("kbd", {}, "Esc")),
    listEl,
    h("div", { class: "palette-foot" }, h("span", {}, "↑↓ move"), h("span", {}, "Enter open"), h("span", {}, "Ctrl K close")));
  inputEl.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(search, 160);
  });
  dialogEl.addEventListener("keydown", onKey);
  dialogEl.addEventListener("close", () => {
    request += 1;
  });
  document.body.append(dialogEl);
}

async function search() {
  const q = inputEl.value.trim();
  if (q.length < 2 || state.mustEnrollMfa) {
    render([]);
    return;
  }
  const token = ++request;
  try {
    const data = await api("GET", `/api/search?q=${encodeURIComponent(q)}`);
    if (token !== request) return;
    render(data.items || []);
  } catch (error) {
    if (token !== request) return;
    render([], error.message);
  }
}

function localItems(query) {
  const q = query.trim().toLowerCase();
  const matches = (text) => !q || String(text || "").toLowerCase().includes(q);
  const out = [];
  if (!state.mustEnrollMfa) {
    for (const action of getActions()) {
      if (matches(action.label)) out.push({ group: "Actions", kind: "Action", ...action });
    }
  }
  for (const page of getPages()) {
    if (matches(`${page.label} ${page.hint || ""}`)) out.push({ group: "Pages", kind: "Page", ...page });
  }
  if (q.length < 2) {
    for (const recent of readRecent()) {
      if (matches(`${recent.label} ${recent.hint || ""}`)) out.push({ group: "Recent", kind: "Recent", ...recent });
    }
  }
  return out;
}

function render(remote, error = "") {
  const q = inputEl.value.trim();
  items = localItems(q);
  if (q.length >= 2 && !state.mustEnrollMfa) {
    const names = { ticket: ["Tickets", "Ticket"], device: ["Devices", "Device"], organization: ["Organizations", "Organization"] };
    for (const item of remote) {
      const [group, kind] = names[item.type] || ["Results", "Result"];
      items.push({ group, kind, label: item.title, hint: item.hint, href: item.href });
    }
  }
  if (active >= items.length) active = 0;
  const nodes = [];
  if (error) nodes.push(h("p", { class: "palette-empty muted" }, error));
  else if (!items.length) nodes.push(h("p", { class: "palette-empty muted" }, q.length >= 2 ? "Nothing matches that." : "Type two letters, or choose a page below."));
  let group = "";
  items.forEach((item, index) => {
    if (item.group !== group) {
      group = item.group;
      nodes.push(h("div", { class: "palette-group" }, group));
    }
    nodes.push(h("button", {
      type: "button",
      class: `palette-item${index === active ? " active" : ""}`,
      role: "option",
      id: `palette-opt-${index}`,
      "aria-selected": index === active ? "true" : "false",
      onclick: () => choose(index),
      onmousemove: () => {
        if (active === index) return;
        active = index;
        markActive();
      },
    }, h("span", { class: "palette-kind" }, item.kind), h("span", { class: "grow" }, h("strong", {}, item.label), item.hint ? h("small", { class: "muted block" }, item.hint) : null)));
  });
  clear(listEl, nodes);
  const current = listEl.querySelector(".palette-item.active");
  if (current) inputEl.setAttribute("aria-activedescendant", current.id);
  else inputEl.removeAttribute("aria-activedescendant");
  current?.scrollIntoView({ block: "nearest" });
}

function markActive() {
  for (const [index, row] of listEl.querySelectorAll(".palette-item").entries()) {
    row.classList.toggle("active", index === active);
    row.setAttribute("aria-selected", index === active ? "true" : "false");
  }
  const current = listEl.querySelector(".palette-item.active");
  if (current) inputEl.setAttribute("aria-activedescendant", current.id);
  current?.scrollIntoView({ block: "nearest" });
}

function onKey(event) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!items.length) return;
    active = event.key === "ArrowDown" ? (active + 1) % items.length : (active - 1 + items.length) % items.length;
    markActive();
  } else if (event.key === "Enter") {
    event.preventDefault();
    choose(active);
  }
}

async function choose(index) {
  const item = items[index];
  if (!item) return;
  dialogEl.close();
  try {
    if (item.run) await item.run();
    else if (item.href && location.hash !== item.href) location.hash = item.href;
  } catch (error) {
    toast(error.message, "error");
  }
}
