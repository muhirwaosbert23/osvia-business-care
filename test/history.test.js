import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { bootstrap, startServer } from "./helpers.js";

let server;
let ctx;

before(async () => {
  server = await startServer();
  ctx = await bootstrap(server.base);
});

after(async () => {
  await server.close();
});

describe("record history", () => {
  test("device edits record before/after values and archiving requires a reason", async () => {
    const { admin, custA, custB, orgA } = ctx;
    const created = await admin.post("/api/devices", { organizationId: orgA, name: "Reception PC", condition: "good" });
    assert.equal(created.status, 201);
    const id = created.data.device.id;

    const edited = await admin.patch(`/api/devices/${id}`, { condition: "poor", model: "OptiPlex 7010", reason: "Fan noise reported" });
    assert.equal(edited.status, 200);

    const noReason = await admin.post(`/api/devices/${id}/archive`, {});
    assert.equal(noReason.status, 400);
    const archived = await admin.post(`/api/devices/${id}/archive`, { reason: "Replaced by a new laptop" });
    assert.equal(archived.status, 200);

    const history = await admin.get(`/api/history?type=device&id=${id}`);
    assert.equal(history.status, 200);
    const [archive, update, create] = history.data.items;
    assert.equal(archive.action, "device.archive");
    assert.equal(archive.reason, "Replaced by a new laptop");
    assert.equal(update.reason, "Fan noise reported");
    assert.deepEqual(update.changes.find((c) => c.field === "condition"), { field: "condition", from: "good", to: "poor" });
    assert.deepEqual(update.changes.find((c) => c.field === "model"), { field: "model", from: null, to: "OptiPlex 7010" });
    assert.equal(create.action, "device.create");
    assert.equal(create.actorName, "Admin");

    const own = await custA.get(`/api/history?type=device&id=${id}`);
    assert.equal(own.status, 200);
    assert.equal(own.data.items.length, 3);
    assert.equal(own.data.items[0].ip, undefined, "customers never see IP addresses");

    const other = await custB.get(`/api/history?type=device&id=${id}`);
    assert.equal(other.status, 404, "another organization cannot read the history");
  });

  test("customers do not see internal notes in ticket history; staff do", async () => {
    const { admin, custA, userA } = ctx;
    const ticket = await custA.post("/api/tickets", { title: "Printer jam", description: "Paper stuck", priority: "normal", category: "printer" });
    assert.equal(ticket.status, 201);
    const id = ticket.data.ticket.id;
    assert.equal((await admin.post(`/api/tickets/${id}/notes`, { kind: "note", body: "Customer's printer is out of warranty" })).status, 201);
    assert.equal((await admin.patch(`/api/tickets/${id}`, { priority: "high", reason: "Blocks invoicing" })).status, 200);

    const staffView = await admin.get(`/api/history?type=ticket&id=${id}`);
    assert.ok(staffView.data.items.some((e) => e.action === "ticket.note"));
    const priority = staffView.data.items.find((e) => e.action === "ticket.update");
    assert.equal(priority.reason, "Blocks invoicing");
    assert.deepEqual(priority.changes.find((c) => c.field === "priority"), { field: "priority", from: "normal", to: "high" });

    const customerView = await custA.get(`/api/history?type=ticket&id=${id}`);
    assert.equal(customerView.status, 200);
    assert.ok(!customerView.data.items.some((e) => e.action === "ticket.note"));
    assert.ok(customerView.data.items.every((e) => !e.changes.some((c) => c.field === "response_due_at")));

    const otherUser = await userA.get(`/api/history?type=ticket&id=${id}`);
    assert.equal(otherUser.status, 404, "a customer user only sees tickets they can open");
  });

  test("role and access changes require a reason and appear in the audit log", async () => {
    const { admin, custA } = ctx;
    const users = await custA.get("/api/users");
    const target = users.data.items.find((u) => u.email === "user@alpha.test");
    assert.equal((await custA.patch(`/api/users/${target.id}`, { role: "customer_admin" })).status, 400);
    assert.equal((await custA.patch(`/api/users/${target.id}`, { role: "customer_admin", reason: "New office manager" })).status, 200);

    const log = await admin.get(`/api/audit?entityType=user&entityId=${target.id}`);
    assert.equal(log.status, 200);
    assert.equal(log.data.items[0].reason, "New office manager");
    assert.deepEqual(log.data.items[0].changes, [{ field: "role", from: "customer_user", to: "customer_admin" }]);
    assert.equal((await custA.patch(`/api/users/${target.id}`, { role: "customer_user", reason: "Back to normal user" })).status, 200);
  });

  test("billing history is limited to administrators and the customer's own administrators", async () => {
    const { tech, admin } = ctx;
    const plans = await admin.get("/api/plans");
    const planId = plans.data.items[0].id;
    assert.equal((await tech.get(`/api/history?type=service_plan&id=${planId}`)).status, 403);
    assert.equal((await admin.get(`/api/history?type=service_plan&id=${planId}`)).status, 200);
    assert.equal((await admin.get("/api/history?type=secrets&id=1")).status, 400);
  });
});
