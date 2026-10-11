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

describe("quick find", () => {
  test("search stays inside what each role is allowed to open", async () => {
    const { admin, tech, custA, userA, custB, orgA } = ctx;
    assert.equal((await fetch(`${server.base}/api/search?q=printer`)).status, 401);

    const printer = await admin.post("/api/devices", { organizationId: orgA, name: "Front Desk Printer", assetTag: "TAG-9", condition: "good" });
    const lookalike = await admin.post("/api/devices", { organizationId: orgA, name: "PCX01", condition: "good" });
    const exact = await admin.post("/api/devices", { organizationId: orgA, name: "PC_01", condition: "good" });
    assert.equal(printer.status, 201);
    assert.equal(lookalike.status, 201);
    assert.equal(exact.status, 201);

    const hidden = await custA.post("/api/tickets", { title: "Front desk printer jam", description: "Paper stuck", priority: "normal", category: "printer" });
    const shared = await custA.post("/api/tickets", { title: "Lobby projector is dark", description: "No image", priority: "normal", category: "other" });
    const percent = await custA.post("/api/tickets", { title: "Disk is 100% full", description: "C: drive", priority: "high", category: "other" });
    assert.equal(hidden.status, 201);
    assert.equal(shared.status, 201);
    assert.equal(percent.status, 201);

    const me = await admin.get("/api/me");
    assert.equal((await admin.patch(`/api/tickets/${hidden.data.ticket.id}`, { assignedTo: me.data.user.id })).status, 200);

    const adminHit = await admin.get("/api/search?q=printer");
    assert.equal(adminHit.status, 200);
    assert.ok(adminHit.data.items.some((item) => item.type === "ticket" && item.title === "Front desk printer jam"));
    assert.ok(adminHit.data.items.some((item) => item.type === "device" && item.href === `#/devices/${printer.data.device.id}`));
    assert.equal(adminHit.data.items.some((item) => item.hint?.includes("@")), false);

    const orgHit = await admin.get("/api/search?q=Alpha");
    assert.ok(orgHit.data.items.some((item) => item.type === "organization" && item.title === "Alpha"));

    const techHit = await tech.get("/api/search?q=printer");
    assert.equal(techHit.data.items.some((item) => item.type === "ticket"), false, "a technician does not see a ticket assigned to someone else");
    assert.ok(techHit.data.items.some((item) => item.type === "device"));
    const techShared = await tech.get("/api/search?q=projector");
    assert.ok(techShared.data.items.some((item) => item.type === "ticket" && item.title === "Lobby projector is dark"));

    const own = await custA.get("/api/search?q=printer");
    assert.ok(own.data.items.some((item) => item.type === "ticket"));
    assert.ok(own.data.items.some((item) => item.type === "device"));
    assert.equal(own.data.items.some((item) => item.type === "organization"), false);

    const otherOrg = await custB.get("/api/search?q=printer");
    assert.deepEqual(otherOrg.data.items, []);
    const otherUser = await userA.get("/api/search?q=printer");
    assert.deepEqual(otherUser.data.items, []);

    const escaped = await admin.get("/api/search?q=" + encodeURIComponent("100%"));
    assert.deepEqual(escaped.data.items.map((item) => item.title), ["Disk is 100% full"]);
    const underscore = await admin.get("/api/search?q=" + encodeURIComponent("PC_"));
    assert.deepEqual(underscore.data.items.filter((item) => item.type === "device").map((item) => item.title), ["PC_01"]);

    assert.deepEqual((await admin.get("/api/search?q=a")).data.items, []);
    assert.deepEqual((await admin.get("/api/search")).data.items, []);
  });
});
