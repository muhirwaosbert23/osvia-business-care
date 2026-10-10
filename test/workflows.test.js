import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { totpCode } from "../server/security.js";
import { bootstrap, Client, PASSWORD, startServer } from "./helpers.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

let env;
let ctx;

before(async () => {
  env = await startServer();
  ctx = await bootstrap(env.base);
});

after(async () => {
  await env.close();
});

describe("authentication", () => {
  test("setup only works once", async () => {
    const res = await new Client(env.base).post("/api/setup", { name: "X", email: "x@osvia.test", password: PASSWORD });
    assert.equal(res.status, 403);
  });

  test("wrong password is rejected without revealing which part was wrong", async () => {
    const res = await new Client(env.base).post("/api/login", { email: "admin@osvia.test", password: "wrong-password-1" });
    assert.equal(res.status, 401);
    assert.match(res.data.error, /Email or password/);
  });

  test("staff must enroll MFA before staff tools work", async () => {
    const res = await ctx.admin.post("/api/invitations", { role: "technician", email: "new-tech@osvia.test" });
    const fresh = new Client(env.base);
    await fresh.post("/api/invitations/accept", { token: res.data.link.split("/#/invite/")[1], name: "New Tech", password: PASSWORD });
    const blocked = await fresh.get("/api/dashboard");
    assert.equal(blocked.status, 403);
    assert.match(blocked.data.error, /two-factor/);
    const me = await fresh.get("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.data.mustEnrollMfa, true);
    await fresh.enrollMfa();
    assert.equal((await fresh.get("/api/dashboard")).status, 200);
  });

  test("login with MFA requires a valid code", async () => {
    const client = new Client(env.base);
    const first = await client.post("/api/login", { email: "admin@osvia.test", password: PASSWORD });
    assert.equal(first.data.mfaRequired, true);
    assert.equal(client.cookie, "");
    const bad = await client.post("/api/login/mfa", { challenge: first.data.challenge, code: "000000" === totpCode(ctx.adminSecret) ? "111111" : "000000" });
    assert.equal(bad.status, 401);
    const good = await client.post("/api/login/mfa", { challenge: first.data.challenge, code: totpCode(ctx.adminSecret) });
    assert.equal(good.status, 200);
    assert.equal((await client.get("/api/dashboard")).status, 200);
  });

  test("state-changing requests need the CSRF token and same origin", async () => {
    const noToken = await fetch(`${env.base}/api/tickets`, { method: "POST", headers: { Cookie: ctx.custA.cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(noToken.status, 403);
    const crossSite = await ctx.custA.call("POST", "/api/tickets", { title: "x", description: "y" }, { headers: { Origin: "https://evil.example" } });
    assert.equal(crossSite.status, 403);
  });

  test("password change keeps the current session and checks the old password", async () => {
    const wrong = await ctx.userA.post("/api/me/password", { currentPassword: "nope-nope-nope", newPassword: "Another-Pass-77" });
    assert.equal(wrong.status, 400);
  });
});

describe("tenant isolation", () => {
  let ticketA;
  let deviceA;

  before(async () => {
    ticketA = (await ctx.custA.post("/api/tickets", { title: "Printer jam", description: "The office printer jams.", category: "printer" })).data.ticket;
    deviceA = (await ctx.custA.post("/api/devices", { name: "Reception PC", assetTag: "A-001" })).data.device;
  });

  test("another organization cannot read records by id", async () => {
    assert.equal((await ctx.custB.get(`/api/tickets/${ticketA.id}`)).status, 404);
    assert.equal((await ctx.custB.get(`/api/devices/${deviceA.id}`)).status, 404);
    assert.equal((await ctx.custB.get(`/api/organizations/${ctx.orgA}`)).status, 404);
    assert.equal((await ctx.custB.post(`/api/tickets/${ticketA.id}/notes`, { body: "hi" })).status, 404);
  });

  test("lists only contain the caller's organization", async () => {
    const tickets = await ctx.custB.get(`/api/tickets?organizationId=${ctx.orgA}`);
    assert.equal(tickets.status, 200);
    assert.ok(tickets.data.items.every((t) => t.organizationId === ctx.orgB));
    const devices = await ctx.custB.get(`/api/devices?organizationId=${ctx.orgA}`);
    assert.ok(devices.data.items.every((d) => d.organizationId === ctx.orgB));
  });

  test("a customer cannot create records in another organization", async () => {
    const res = await ctx.custB.post("/api/tickets", { organizationId: ctx.orgA, title: "Sneaky", description: "Should land in Bravo" });
    assert.equal(res.status, 201);
    assert.equal(res.data.ticket.organizationId, ctx.orgB);
    const device = await ctx.custB.post("/api/tickets", { title: "Wrong device", description: "x", deviceId: deviceA.id });
    assert.equal(device.status, 400);
  });

  test("customer users only see their own tickets", async () => {
    await ctx.userA.post("/api/tickets", { title: "My laptop", description: "Slow" });
    const list = await ctx.userA.get("/api/tickets");
    assert.ok(list.data.items.length >= 1);
    assert.ok(list.data.items.every((t) => t.title === "My laptop"));
    assert.equal((await ctx.userA.get(`/api/tickets/${ticketA.id}`)).status, 404);
  });

  test("customers cannot use staff-only endpoints", async () => {
    assert.equal((await ctx.custA.patch(`/api/tickets/${ticketA.id}`, { status: "resolved" })).status, 403);
    assert.equal((await ctx.custA.post("/api/monitors", { organizationId: ctx.orgA, name: "x", type: "ping", target: "8.8.8.8" })).status, 403);
    assert.equal((await ctx.custA.patch(`/api/devices/${deviceA.id}`, { address: "10.0.0.5" })).status, 403);
    assert.equal((await ctx.custA.post("/api/invoices", { organizationId: ctx.orgA, amount: 1000 })).status, 403);
    assert.equal((await ctx.userA.get("/api/invoices")).status, 403);
    assert.equal((await ctx.custA.get("/api/settings")).status, 403);
    assert.equal((await ctx.custA.get("/api/system")).status, 403);
  });

  test("the customer audit view is limited to the organization", async () => {
    const res = await ctx.custA.get(`/api/audit?organizationId=${ctx.orgB}`);
    assert.equal(res.status, 200);
    assert.ok(res.data.items.every((a) => a.organizationId === ctx.orgA));
  });

  test("technicians cannot grant themselves other technicians' tickets", async () => {
    const other = await ctx.invite("technician", "tech2@osvia.test");
    await other.enrollMfa();
    const me = await other.get("/api/me");
    const res = await ctx.tech.patch(`/api/tickets/${ticketA.id}`, { assignedTo: me.data.user.id });
    assert.equal(res.status, 403);
  });
});

describe("ticket lifecycle", () => {
  test("moves through the full workflow with SLA pause and reopen", async () => {
    const created = await ctx.custA.post("/api/tickets", { title: "Email down", description: "Outlook will not send", priority: "high", category: "email" });
    assert.equal(created.status, 201);
    const ticket = created.data.ticket;
    assert.match(ticket.number, /^OBC-\d{6}$/);
    assert.equal(ticket.status, "new");

    const techMe = (await ctx.tech.get("/api/me")).data.user;
    let res = await ctx.tech.patch(`/api/tickets/${ticket.id}`, { assignedTo: techMe.id });
    assert.equal(res.data.ticket.status, "open");
    assert.equal(res.data.ticket.assignedTo, techMe.id);

    assert.equal((await ctx.tech.patch(`/api/tickets/${ticket.id}`, { status: "closed" })).status, 400);

    res = await ctx.tech.patch(`/api/tickets/${ticket.id}`, { status: "in_progress" });
    assert.ok(res.data.ticket.firstResponseAt);

    res = await ctx.tech.post(`/api/tickets/${ticket.id}/notes`, { kind: "note", body: "Internal: check the mail relay" });
    assert.equal(res.status, 201);
    assert.equal((await ctx.tech.post(`/api/tickets/${ticket.id}/notes`, { kind: "work_log", body: "Checked relay" })).status, 400);
    res = await ctx.tech.post(`/api/tickets/${ticket.id}/notes`, { kind: "work_log", body: "Checked relay", minutesSpent: 25 });
    assert.equal(res.data.ticket.minutesLogged, 25);

    const customerView = await ctx.custA.get(`/api/tickets/${ticket.id}`);
    assert.ok(customerView.data.notes.every((n) => n.visibility === "customer"));
    assert.equal(customerView.data.ticket.minutesLogged, undefined);

    res = await ctx.tech.patch(`/api/tickets/${ticket.id}`, { status: "pending_customer" });
    assert.equal(res.data.ticket.status, "pending_customer");

    res = await ctx.custA.post(`/api/tickets/${ticket.id}/notes`, { body: "Here is the error message." });
    assert.equal(res.data.ticket.status, "open");
    assert.equal(res.data.ticket.slaPaused, false);

    assert.equal((await ctx.tech.patch(`/api/tickets/${ticket.id}`, { status: "resolved" })).status, 400);
    res = await ctx.tech.patch(`/api/tickets/${ticket.id}`, { status: "resolved", resolutionSummary: "Reset the SMTP password." });
    assert.equal(res.data.ticket.status, "resolved");

    res = await ctx.custA.post(`/api/tickets/${ticket.id}/reopen`);
    assert.equal(res.data.ticket.status, "open");
    assert.equal(res.data.ticket.reopenedCount, 1);

    await ctx.tech.patch(`/api/tickets/${ticket.id}`, { status: "resolved" });
    res = await ctx.custA.post(`/api/tickets/${ticket.id}/close`);
    assert.equal(res.data.ticket.status, "closed");
    assert.equal((await ctx.custA.post(`/api/tickets/${ticket.id}/notes`, { body: "One more thing" })).status, 400);
    assert.equal((await ctx.tech.patch(`/api/tickets/${ticket.id}`, { status: "open" })).status, 403);

    const detail = await ctx.admin.get(`/api/tickets/${ticket.id}`);
    const statuses = detail.data.events.map((e) => e.toStatus);
    assert.deepEqual(statuses.filter((s, i) => s !== statuses[i - 1]), ["new", "open", "in_progress", "pending_customer", "open", "resolved", "open", "resolved", "closed"]);
  });
});

describe("attachments", () => {
  let ticket;
  before(async () => {
    ticket = (await ctx.custA.post("/api/tickets", { title: "Screen", description: "Screenshot attached" })).data.ticket;
  });

  async function upload(client, body, type, extra = {}) {
    return client.call("POST", `/api/tickets/${ticket.id}/attachments`, undefined, { rawBody: body, headers: { "Content-Type": type, "X-File-Name": "shot.png", ...extra } });
  }

  test("accepts images and rejects executables by content", async () => {
    const ok = await upload(ctx.custA, PNG, "image/png");
    assert.equal(ok.status, 201);
    assert.equal(ok.data.attachments.length, 1);
    const exe = await upload(ctx.custA, Buffer.from("MZ\x90\x00 this is not an image"), "image/png");
    assert.equal(exe.status, 415);
    const tooBig = await upload(ctx.custA, Buffer.alloc(5 * 1024 * 1024 + 10, 1), "image/png");
    assert.equal(tooBig.status, 413);
  });

  test("downloads are authorized and internal files stay internal", async () => {
    const internal = await upload(ctx.admin, PNG, "image/png", { "X-Visibility": "internal" });
    const files = internal.data.attachments;
    const customerFile = files.find((f) => f.visibility === "customer");
    const internalFile = files.find((f) => f.visibility === "internal");
    const download = await ctx.custA.raw("GET", `/api/attachments/${customerFile.id}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "image/png");
    assert.match(download.headers.get("content-disposition"), /attachment/);
    assert.equal((await ctx.custB.raw("GET", `/api/attachments/${customerFile.id}`)).status, 404);
    assert.equal((await ctx.custA.raw("GET", `/api/attachments/${internalFile.id}`)).status, 404);
    const view = await ctx.custA.get(`/api/tickets/${ticket.id}`);
    assert.ok(view.data.attachments.every((f) => f.visibility === "customer"));
  });
});

describe("billing", () => {
  test("payments stay pending until an administrator verifies them", async () => {
    const plans = (await ctx.custA.get("/api/plans")).data.items;
    const business = plans.find((p) => p.name === "Business");
    const invoice = (await ctx.admin.post("/api/invoices", { organizationId: ctx.orgA, planId: business.id })).data.invoice;
    assert.match(invoice.number, /^INV-\d{4}-0001$/);
    assert.equal(invoice.amount, business.price);
    const second = (await ctx.admin.post("/api/invoices", { organizationId: ctx.orgB, amount: 5000, description: "Call-out" })).data.invoice;
    assert.match(second.number, /-0002$/);

    assert.equal((await ctx.admin.post(`/api/organizations/${ctx.orgA}/subscription`, { status: "active" })).status, 400);

    const recorded = await ctx.custA.post("/api/payments", { invoiceId: invoice.id, amount: business.price, method: "mobile_money_manual", reference: "MM-123456" });
    assert.equal(recorded.status, 201);
    assert.equal(recorded.data.payment.status, "pending");
    assert.equal((await ctx.custA.post("/api/payments", { invoiceId: invoice.id, amount: 1, method: "mobile_money_manual", reference: "MM-123456" })).status, 409);

    let summary = (await ctx.custA.get("/api/billing/summary")).data;
    assert.equal(summary.subscriptionStatus, "unpaid");
    assert.equal(summary.pendingPayments, 1);

    const paymentId = recorded.data.payment.id;
    assert.equal((await ctx.custA.post(`/api/payments/${paymentId}/verify`, { confirmReceived: true, reconciliationNote: "x" })).status, 403);
    assert.equal((await ctx.admin.post(`/api/payments/${paymentId}/verify`, { reconciliationNote: "x" })).status, 400);
    assert.equal((await ctx.custA.raw("GET", `/api/payments/${paymentId}/receipt`)).status, 400);

    const verified = await ctx.admin.post(`/api/payments/${paymentId}/verify`, { confirmReceived: true, reconciliationNote: "Matched MTN statement line 14" });
    assert.equal(verified.data.payment.status, "verified");
    assert.equal((await ctx.admin.post(`/api/payments/${paymentId}/reject`, { reason: "oops" })).status, 400);

    summary = (await ctx.custA.get("/api/billing/summary")).data;
    assert.equal(summary.subscriptionStatus, "active");
    assert.equal(summary.renewalDate, invoice.periodEnd);
    assert.equal(summary.outstanding, 0);
    const paid = (await ctx.custA.get(`/api/invoices/${invoice.id}`)).data.invoice;
    assert.equal(paid.status, "paid");

    const receipt = await ctx.custA.raw("GET", `/api/payments/${paymentId}/receipt`);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.headers.get("content-type"), "application/pdf");
    assert.equal((await ctx.custB.raw("GET", `/api/invoices/${invoice.id}/pdf`)).status, 404);
    assert.equal((await ctx.admin.post(`/api/invoices/${invoice.id}/void`, { reason: "test" })).status, 400);
  });

  test("a rejected payment never activates anything", async () => {
    const invoice = (await ctx.admin.post("/api/invoices", { organizationId: ctx.orgB, amount: 20000 })).data.invoice;
    const pay = (await ctx.custB.post("/api/payments", { invoiceId: invoice.id, amount: 20000, method: "bank_transfer", reference: "BT-1" })).data.payment;
    const rejected = await ctx.admin.post(`/api/payments/${pay.id}/reject`, { reason: "Not on statement" });
    assert.equal(rejected.data.payment.status, "rejected");
    assert.equal((await ctx.custB.get("/api/billing/summary")).data.subscriptionStatus, "unpaid");
  });
});

describe("reports", () => {
  test("permissions and scoping", async () => {
    assert.equal((await ctx.userA.get("/api/reports/summary")).status, 403);
    const scoped = await ctx.custA.get(`/api/reports/summary?organizationId=${ctx.orgB}`);
    assert.equal(scoped.status, 200);
    assert.equal(scoped.data.organization, "Alpha");
    assert.equal(scoped.data.technicians, undefined);
    const staff = await ctx.admin.get("/api/reports/summary");
    assert.ok(Array.isArray(staff.data.technicians));
    assert.ok(staff.data.tickets.created >= 3);
  });

  test("PDF and CSV exports", async () => {
    const pdf = await ctx.custA.raw("GET", "/api/reports/summary.pdf");
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    const csv = await ctx.custA.raw("GET", "/api/reports/tickets.csv");
    const bytes = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    assert.match(text, /^\uFEFFNumber,Organization/);
    assert.ok(!text.includes("Bravo"));
  });
});

describe("organization suspension", () => {
  test("suspension blocks sign-in and reactivation restores it", async () => {
    const client = new Client(env.base);
    assert.equal((await client.login("user@alpha.test")).status, 200);
    assert.equal((await ctx.admin.post(`/api/organizations/${ctx.orgA}/suspend`, { reason: "Unpaid" })).status, 200);
    assert.equal((await client.get("/api/me")).status, 401);
    const blocked = await new Client(env.base).login("user@alpha.test");
    assert.equal(blocked.status, 403);
    assert.equal((await ctx.admin.post(`/api/organizations/${ctx.orgA}/reactivate`)).status, 200);
    const again = new Client(env.base);
    assert.equal((await again.login("user@alpha.test")).status, 200);
    ctx.userA = again;
    ctx.custA = new Client(env.base);
    await ctx.custA.login("admin@alpha.test");
  });

  test("pending organizations can sign in but not open tickets", async () => {
    const client = new Client(env.base);
    const reg = await client.post("/api/register", { organizationName: "Charlie", contactName: "C", email: "c@charlie.test", password: PASSWORD });
    assert.equal(reg.status, 201);
    await client.login("c@charlie.test");
    const res = await client.post("/api/tickets", { title: "Help", description: "Help" });
    assert.equal(res.status, 403);
    assert.match(res.data.error, /reviewing/);
  });
});

describe("remote support", () => {
  test("requires a linked agent, customer consent and MFA, and is recorded", async () => {
    const device = (await ctx.custA.post("/api/devices", { name: "Accounts PC" })).data.device;
    let res = await ctx.tech.post(`/api/devices/${device.id}/remote`, { reason: "Ticket follow-up" });
    assert.equal(res.status, 400);
    env.db.prepare("UPDATE devices SET mesh_node_id = 'node//abc$def' WHERE id = ?").run(device.id);
    res = await ctx.tech.post(`/api/devices/${device.id}/remote`, { reason: "Ticket follow-up" });
    assert.equal(res.status, 403);
    assert.match(res.data.error, /consent/);
    assert.equal((await ctx.custA.post(`/api/devices/${device.id}/consent`, { confirm: true })).status, 200);
    process.env.MESHCENTRAL_URL = "https://mesh.example.test";
    try {
      assert.equal((await ctx.tech.post(`/api/devices/${device.id}/remote`, {})).status, 400);
      res = await ctx.tech.post(`/api/devices/${device.id}/remote`, { reason: "Install printer driver", mode: "desktop" });
      assert.equal(res.status, 200);
      assert.equal(res.data.url, "https://mesh.example.test/?gotonode=abc%24def&viewmode=11");
    } finally {
      delete process.env.MESHCENTRAL_URL;
    }
    const detail = await ctx.custA.get(`/api/devices/${device.id}`);
    assert.equal(detail.data.remoteSessions.length, 1);
    assert.equal(detail.data.device.meshNodeId, undefined);
    const notes = await ctx.custA.get("/api/notifications");
    assert.ok(notes.data.items.some((n) => n.kind === "remote"));
  });
});
