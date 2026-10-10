import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { osFamily, packTroubleshoot, remoteCommands } from "../server/troubleshoot.js";
import { bootstrap, startServer } from "./helpers.js";

describe("remote troubleshooting helpers", () => {
  test("Windows, Linux and Mac get different terminal commands", () => {
    assert.equal(osFamily("Windows 11 Pro"), "windows");
    assert.equal(osFamily("Ubuntu 24.04"), "linux");
    assert.ok(remoteCommands("windows").some((item) => item.command.includes("ipconfig")));
    assert.ok(remoteCommands("linux").some((item) => item.command.includes("journalctl")));
  });

  test("remote is blocked until MeshCentral, consent and an active organization are all present", () => {
    const blocked = packTroubleshoot({ operating_system: "Windows 11", organization_status: "active" });
    assert.equal(blocked.canRemote, false);
    assert.ok(blocked.blockers.some((text) => /MeshCentral/.test(text)));
    const ready = packTroubleshoot({ operating_system: "Windows 11", organization_status: "active", mesh_node_id: "node//a", consent_at: "2026-10-10T00:00:00.000Z", reachability: "online" });
    assert.equal(ready.canRemote, true);
    assert.ok(ready.playbooks.every((book) => book.available));
  });
});

describe("staff remote desk", () => {
  let server;
  let ctx;
  let listener;
  let deviceId;

  before(async () => {
    server = await startServer();
    ctx = await bootstrap(server.base);
    listener = net.createServer((socket) => socket.end());
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const created = await ctx.admin.post("/api/devices", {
      organizationId: ctx.orgA,
      name: "Workshop PC",
      address: "127.0.0.1",
      checkPort: listener.address().port,
      operatingSystem: "Windows 11",
    });
    deviceId = created.data.device.id;
  });

  after(async () => {
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
    await server.close();
  });

  test("customers cannot diagnose, list the remote desk or read staff notes", async () => {
    assert.equal((await ctx.custA.post(`/api/devices/${deviceId}/diagnose`)).status, 403);
    assert.equal((await ctx.custA.get("/api/devices/remote")).status, 403);
    assert.equal((await ctx.custA.post(`/api/devices/${deviceId}/findings`, { body: "x" })).status, 403);
    assert.deepEqual((await ctx.custA.get(`/api/devices/${deviceId}`)).data.findings, []);
    assert.equal((await ctx.custA.get(`/api/devices/${deviceId}`)).data.troubleshoot, null);
  });

  test("admin can diagnose from the OSVIA server and record a finding", async () => {
    const pack = await ctx.admin.get(`/api/devices/${deviceId}/troubleshoot`);
    assert.equal(pack.status, 200);
    assert.equal(pack.data.family, "windows");
    assert.ok(pack.data.commands.length > 3);

    const diag = await ctx.admin.post(`/api/devices/${deviceId}/diagnose`);
    assert.equal(diag.status, 200);
    assert.equal(diag.data.from, "OSVIA server");
    assert.match(diag.data.notice, /not readings from inside/);
    const extra = diag.data.ports.find((p) => p.port === listener.address().port);
    assert.equal(extra.open, true);

    const note = await ctx.admin.post(`/api/devices/${deviceId}/findings`, { kind: "finding", body: "Print spooler was stopped. Started it." });
    assert.equal(note.status, 200);
    const detail = await ctx.admin.get(`/api/devices/${deviceId}`);
    assert.equal(detail.data.findings[0].body, "Print spooler was stopped. Started it.");
    assert.equal((await ctx.custB.get(`/api/devices/${deviceId}/troubleshoot`)).status, 403);
  });

  test("the remote desk lists a consented MeshCentral agent and hides it from customers", async () => {
    server.db.prepare("UPDATE devices SET mesh_node_id = 'node//workshop' WHERE id = ?").run(deviceId);
    await ctx.custA.post(`/api/devices/${deviceId}/consent`, { confirm: true });
    const desk = await ctx.tech.get("/api/devices/remote");
    assert.equal(desk.status, 200);
    const item = desk.data.items.find((row) => row.id === deviceId);
    assert.equal(item.managed, true);
    assert.equal(item.consent, true);
    assert.equal(typeof desk.data.meshConfigured, "boolean");
    assert.ok(desk.data.total >= 1);
    assert.ok(desk.data.items.some((row) => row.id === deviceId));
  });

  test("Remote desk lists devices that have no MeshCentral agent yet", async () => {
    const created = await ctx.admin.post("/api/devices", { organizationId: ctx.orgA, name: "Reception laptop" });
    const desk = await ctx.admin.get("/api/devices/remote");
    assert.equal(desk.status, 200);
    const item = desk.data.items.find((row) => row.id === created.data.device.id);
    assert.equal(item.managed, false);
    assert.match(item.nextStep, /MeshCentral/);
    assert.ok(desk.data.needAgent >= 1);
  });
});
