import {
  api, badge, button, card, clear, dataTable, download, errorBox, fmtDate, fmtDateTime, formDialog, h, isRole, label, money, orgOptions,
  pageHeader, PAYMENT_METHODS, skeleton, stat, toast,
} from "./core.js";

const METHOD_LABELS = { mobile_money_manual: "Mobile money", bank_transfer: "Bank transfer", cash: "Cash", cheque: "Cheque", other: "Other" };

function invoiceTable({ orgScoped }) {
  const admin = isRole("admin");
  const table = dataTable({
    columns: [
      { label: "Invoice", render: (i) => h("div", {}, h("span", { class: "mono" }, i.number), h("small", { class: "muted block" }, i.description)) },
      orgScoped ? null : { label: "Organization", key: "organizationName" },
      { label: "Amount", render: (i) => money(i.amount, i.currency) },
      { label: "Balance", render: (i) => (i.status === "issued" ? money(i.balance, i.currency) : "—") },
      { label: "Due", render: (i) => fmtDate(i.dueDate) },
      { label: "Status", render: (i) => [i.overdue ? badge("past_due", "Overdue") : badge(i.status), i.pendingPayments ? h("small", { class: "muted block" }, `${i.pendingPayments} payment(s) being verified`) : null] },
      { label: "", render: (i) => h("div", { class: "row-actions" },
        button("PDF", () => download(`/api/invoices/${i.id}/pdf`), { kind: "small ghost", iconName: "download" }),
        !admin && i.status === "issued" ? button("I have paid", () => paymentDialog(i, () => table.refresh()), { kind: "small primary" }) : null,
        admin && i.status === "issued" && !i.paidAmount ? button("Void", () => formDialog(`Void ${i.number}`, [{ name: "reason", label: "Reason", required: true, max: 300 }], async (values, close) => {
          await api("POST", `/api/invoices/${i.id}/void`, values);
          close();
          toast("Invoice voided.");
          table.refresh();
        }, { submitLabel: "Void invoice" }), { kind: "small ghost danger-text" }) : null) },
    ].filter(Boolean),
    filters: [{ name: "status", label: "Status", value: "", options: [["", "All invoices"], ["issued", "Unpaid"], ["overdue", "Overdue"], ["paid", "Paid"], ["void", "Void"]] }],
    searchPlaceholder: null,
    load: (q) => api("GET", `/api/invoices?${q}`),
    emptyText: "No invoices.",
  });
  return table;
}

function paymentTable({ orgScoped, onChange }) {
  const admin = isRole("admin");
  const table = dataTable({
    columns: [
      { label: "Recorded", render: (p) => fmtDateTime(p.createdAt) },
      orgScoped ? null : { label: "Organization", key: "organizationName" },
      { label: "Amount", render: (p) => money(p.amount, p.currency) },
      { label: "Method", render: (p) => METHOD_LABELS[p.method] || label(p.method) },
      { label: "Reference", render: (p) => h("span", { class: "mono" }, p.reference) },
      { label: "Invoice", render: (p) => p.invoiceNumber || "—" },
      { label: "Status", render: (p) => [badge(p.status), p.status === "pending" ? h("small", { class: "muted block" }, "Not yet confirmed by OSVIA") : null, p.rejectedReason ? h("small", { class: "muted block" }, p.rejectedReason) : null, p.verifiedBy && p.status === "verified" ? h("small", { class: "muted block" }, `by ${p.verifiedBy}`) : null] },
      { label: "", render: (p) => h("div", { class: "row-actions" },
        p.status === "verified" ? button("Receipt", () => download(`/api/payments/${p.id}/receipt`), { kind: "small ghost", iconName: "download" }) : null,
        admin && p.status === "pending" ? button("Verify", () => verifyDialog(p, () => { table.refresh(); onChange?.(); }), { kind: "small primary" }) : null,
        admin && p.status === "pending" ? button("Reject", () => formDialog("Reject payment", [{ name: "reason", label: "Reason shown to the customer", required: true, max: 300, placeholder: "e.g. Reference not found on the statement" }], async (values, close) => {
          await api("POST", `/api/payments/${p.id}/reject`, values);
          close();
          toast("Payment rejected.");
          table.refresh();
        }, { submitLabel: "Reject" }), { kind: "small ghost danger-text" }) : null) },
    ].filter(Boolean),
    filters: [{ name: "status", label: "Status", value: admin ? "pending" : "", options: [["", "All payments"], ["pending", "Awaiting verification"], ["verified", "Verified"], ["rejected", "Rejected"]] }],
    searchPlaceholder: null,
    load: (q) => api("GET", `/api/payments?${q}`),
    emptyText: admin ? "No payments match." : "No payments recorded.",
  });
  return table;
}

function verifyDialog(p, onDone) {
  formDialog("Verify payment", [
    { type: "note", label: `${money(p.amount, p.currency)} by ${METHOD_LABELS[p.method] || p.method}, reference ${p.reference}, from ${p.organizationName}. Verify only after you find this amount and reference in the OSVIA bank or mobile-money statement. Verified payments cannot be changed.` },
    { name: "confirmReceived", label: "I found this money in the OSVIA statement", type: "checkbox" },
    { name: "reconciliationNote", label: "Where you matched it", required: true, max: 500, placeholder: "e.g. MTN MoMo statement 12 Oct, line 14" },
  ], async (values, close) => {
    await api("POST", `/api/payments/${p.id}/verify`, values);
    close();
    toast("Payment verified.");
    onDone?.();
  }, { submitLabel: "Verify payment" });
}

function paymentDialog(invoice, onDone, organizationId = null) {
  formDialog("Report a payment", [
    { type: "note", label: "Tell OSVIA about a payment you made. It stays pending until OSVIA confirms the money arrived; this form does not move any money." },
    { name: "amount", label: "Amount (UGX)", type: "number", required: true, min: 1, value: invoice?.balance ?? "" },
    { name: "method", label: "How you paid", type: "select", options: PAYMENT_METHODS.map((m) => [m, METHOD_LABELS[m]]) },
    { name: "reference", label: "Transaction reference", required: true, max: 120, help: "The mobile-money transaction ID or bank reference." },
    { name: "note", label: "Note", max: 500 },
  ], async (values, close) => {
    await api("POST", "/api/payments", { ...values, invoiceId: invoice?.id, organizationId });
    close();
    toast("Recorded as pending. OSVIA will verify it.");
    onDone?.();
  }, { submitLabel: "Submit for verification" });
}

async function invoiceDialog(onDone) {
  const [orgs, plans] = await Promise.all([orgOptions(), api("GET", "/api/plans")]);
  formDialog("Issue invoice", [
    { name: "organizationId", label: "Organization", type: "select", required: true, options: orgs },
    { name: "planId", label: "Plan", type: "select", options: [["", "Organization's current plan"], ...plans.items.map((p) => [String(p.id), `${p.name} · ${money(p.price, p.currency)}`])] },
    { name: "amount", label: "Amount (UGX)", type: "number", min: 1, help: "Leave empty to use the plan price." },
    { name: "description", label: "Description", max: 300, help: "Leave empty for the plan and period." },
    { name: "periodStart", label: "Service period start", type: "date", help: "Defaults to the renewal date or today." },
    { name: "dueDate", label: "Due date", type: "date" },
  ], async (values, close) => {
    const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "" && v !== null));
    body.organizationId = Number(body.organizationId);
    if (body.planId) body.planId = Number(body.planId);
    const res = await api("POST", "/api/invoices", body);
    close();
    toast(`${res.invoice.number} issued.`);
    onDone?.();
  }, { wide: true, submitLabel: "Issue invoice" });
}

function planDialog(plan, onDone) {
  formDialog(plan ? `Edit ${plan.name}` : "New plan", [
    { name: "name", label: "Name", required: true, max: 80, value: plan?.name },
    { name: "price", label: "Price (UGX)", type: "number", required: true, min: 1, value: plan?.price },
    { name: "billingPeriodMonths", label: "Billing period (months)", type: "number", min: 1, maxValue: 24, value: plan?.billingPeriodMonths ?? 1 },
    { name: "deviceLimit", label: "Devices covered", type: "number", required: true, min: 1, value: plan?.deviceLimit },
    { name: "monitorLimit", label: "Monitors included", type: "number", min: 0, value: plan?.monitorLimit ?? 2 },
    { name: "supportHours", label: "Support hours per month", type: "number", required: true, min: 0, value: plan?.supportHours },
    { name: "responseTargetHours", label: "Advertised response target (hours)", type: "number", required: true, min: 1, value: plan?.responseTargetHours },
    { name: "onsiteVisits", label: "On-site visits per period", type: "number", min: 0, value: plan?.onsiteVisits ?? 0 },
    { name: "description", label: "Description", type: "textarea", rows: 2, required: true, max: 1000, value: plan?.description, full: true },
    { name: "remoteSupport", label: "Includes remote support", type: "checkbox", value: plan ? plan.remoteSupport : true },
    { name: "active", label: "Offered to customers", type: "checkbox", value: plan ? plan.active : true },
  ], async (values, close) => {
    if (plan) await api("PATCH", `/api/plans/${plan.id}`, values);
    else await api("POST", "/api/plans", values);
    close();
    toast("Plan saved. SLA targets are managed under Settings.");
    onDone?.();
  }, { wide: true });
}

function plansGrid(plans, { onRequest, onEdit, currentPlanId }) {
  return h("div", { class: "plans" }, plans.map((p) => h("article", { class: `plan ${p.id === currentPlanId ? "current" : ""} ${p.active ? "" : "inactive"}` },
    h("h3", {}, p.name, p.id === currentPlanId ? h("span", { class: "chip" }, "Current") : null, !p.active ? h("span", { class: "chip" }, "Hidden") : null),
    h("p", { class: "price" }, money(p.price, p.currency), h("small", {}, p.billingPeriodMonths === 1 ? " / month" : ` / ${p.billingPeriodMonths} months`)),
    h("p", { class: "muted small" }, p.description),
    h("ul", {}, h("li", {}, `Up to ${p.deviceLimit} devices`), h("li", {}, `${p.supportHours} support hours`), h("li", {}, `${p.monitorLimit} monitors`), h("li", {}, `Response target ${p.responseTargetHours} h`), p.onsiteVisits ? h("li", {}, `${p.onsiteVisits} on-site visit(s)`) : null, p.remoteSupport ? h("li", {}, "Remote support") : null),
    onRequest && p.id !== currentPlanId ? button("Request this plan", () => onRequest(p), { kind: "ghost block" }) : null,
    onEdit ? button("Edit", () => onEdit(p), { kind: "ghost block" }) : null)));
}

export async function billingPage(main, query) {
  if (isRole("admin")) return adminBilling(main, query);
  clear(main, pageHeader("Billing"), skeleton(6));
  try {
    const [summary, plans] = await Promise.all([api("GET", "/api/billing/summary"), api("GET", "/api/plans")]);
    const invoices = invoiceTable({ orgScoped: true });
    const payments = paymentTable({ orgScoped: true });
    clear(main,
      pageHeader("Billing", "Invoices, payments and your service plan. All amounts are in Uganda shillings.", [button("Report a payment", () => paymentDialog(null, () => payments.refresh()), { kind: "primary" })]),
      h("div", { class: "stats" },
        stat("Plan", summary.planName || "None", { hint: summary.price ? money(summary.price) : "" }),
        stat("Subscription", label(summary.subscriptionStatus), { tone: summary.subscriptionStatus === "active" ? "ok" : summary.subscriptionStatus === "past_due" ? "bad" : "warn", hint: summary.renewalDate ? `Renews ${fmtDate(summary.renewalDate)}` : "" }),
        stat("Outstanding", money(summary.outstanding), { tone: summary.overdueInvoices ? "bad" : "" }),
        stat("Payments being verified", summary.pendingPayments, { tone: summary.pendingPayments ? "warn" : "" })),
      card("Invoices", invoices.el),
      card("Payments", payments.el),
      card("Service plans", plansGrid(plans.items, {
        currentPlanId: summary.planId,
        onRequest: (p) => formDialog(`Request the ${p.name} plan`, [{ type: "note", label: "OSVIA will confirm the change and issue an invoice." }, { name: "note", label: "Message (optional)", max: 300 }], async (values, close) => {
          const r = await api("POST", "/api/billing/request-plan", { planId: p.id, note: values.note });
          close();
          toast(r.message);
        }, { submitLabel: "Send request" }),
      })));
  } catch (error) {
    clear(main, pageHeader("Billing"), errorBox(error, () => billingPage(main, query)));
  }
}

function adminBilling(main, query) {
  const tab = query.get("tab") || "payments";
  const tabs = h("nav", { class: "tabs" },
    h("a", { href: "#/billing", class: tab === "payments" ? "active" : "" }, "Payments to verify"),
    h("a", { href: "#/billing?tab=invoices", class: tab === "invoices" ? "active" : "" }, "Invoices"),
    h("a", { href: "#/billing?tab=plans", class: tab === "plans" ? "active" : "" }, "Plans"));
  const content = h("div");
  const actions = [];
  if (tab === "invoices") {
    const table = invoiceTable({ orgScoped: false });
    actions.push(button("Issue invoice", () => invoiceDialog(() => table.refresh()), { kind: "primary", iconName: "plus" }));
    content.append(table.el);
  } else if (tab === "plans") {
    const load = async () => {
      const plans = await api("GET", "/api/plans");
      clear(content, plansGrid(plans.items, { onEdit: (p) => planDialog(p, load) }));
    };
    actions.push(button("New plan", () => planDialog(null, load), { kind: "primary", iconName: "plus" }));
    load().catch((e) => clear(content, errorBox(e, load)));
  } else {
    const table = paymentTable({ orgScoped: false });
    actions.push(button("Record payment", async () => formDialog("Record payment for", [{ name: "organizationId", label: "Organization", type: "select", required: true, options: await orgOptions() }], async (values, close) => {
      close();
      paymentDialog(null, () => table.refresh(), Number(values.organizationId));
    }, { submitLabel: "Continue" }), { kind: "ghost" }));
    content.append(h("p", { class: "muted" }, "Payments reported by customers or recorded by staff stay pending until you match them to the OSVIA statement. Only verified payments mark invoices paid and activate subscriptions."), table.el);
  }
  clear(main, pageHeader("Billing", "Invoices, manual payment verification and service plans (UGX).", actions), tabs, content);
}

export function subscriptionCard(org, reload) {
  return card("Subscription", [
    h("p", {}, `${org.planName || "No plan"} · `, badge(org.subscriptionStatus), org.renewalDate ? ` · renews ${fmtDate(org.renewalDate)}` : ""),
    isRole("admin") ? h("div", { class: "row" },
      button("Change plan", async () => {
        const plans = await api("GET", "/api/plans");
        formDialog("Change plan", [{ name: "planId", label: "Plan", type: "select", options: [["", "No plan"], ...plans.items.map((p) => [String(p.id), `${p.name} · ${money(p.price)}`])], value: org.planId ? String(org.planId) : "" }, { name: "note", label: "Note", max: 300 }, { type: "note", label: "This does not activate the subscription. Issue an invoice; it activates when a payment is verified." }], async (values, close) => {
          await api("POST", `/api/organizations/${org.id}/subscription`, { planId: values.planId ? Number(values.planId) : null, note: values.note });
          close();
          reload();
        });
      }, { kind: "ghost small" }),
      button("Set status", () => formDialog("Subscription status", [{ name: "status", label: "Status", type: "select", options: [["unpaid", "Unpaid"], ["past_due", "Past due"], ["suspended", "Suspended"], ["cancelled", "Cancelled"]], value: org.subscriptionStatus }, { name: "note", label: "Reason", max: 300 }, { type: "note", label: "Active can only be reached by verifying a payment." }], async (values, close) => {
        await api("POST", `/api/organizations/${org.id}/subscription`, values);
        close();
        reload();
      }), { kind: "ghost small" }),
      button("Issue invoice", () => invoiceDialog(reload), { kind: "ghost small" })) : null,
  ]);
}
