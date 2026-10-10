import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { availability } from "../server/modules/devices.js";
import { bootstrap, startServer } from "./helpers.js";

const H = 3600000;

describe("availability arithmetic", () => {
  test("only time between real checks counts; time after the last check is unknown", () => {
    const from = Date.parse("2026-10-01T00:00:00Z");
    const to = from + 2 * 24 * H;
    const events = [
      { status: "online", created_at: new Date(from + 6 * H).toISOString() },
      { status: "offline", created_at: new Date(from + 12 * H).toISOString() },
      { status: "online", created_at: new Date(from + 15 * H).toISOString() },
    ];
    const result = availability(events, { from, to, lastChecked: new Date(from + 24 * H).toISOString(), days: 2 });
    // Known: 06:00-24:00 on day 1 = 18 h, of which 3 h offline.
    assert.equal(result.uptimePercent, Math.round((15 / 18) * 10000) / 100);
    assert.equal(result.coveragePercent, Math.round((18 / 48) * 1000) / 10);
    assert.equal(result.daily[0].coveredHours, 18);
    assert.equal(result.daily[1].uptimePercent, null, "no checks on day 2 means no data, not 100%");
  });

  test("a device that was never checked has no uptime figure", () => {
    const from = Date.now() - 7 * 24 * H;
    const result = availability([], { from, to: Date.now(), lastChecked: null, days: 7 });
    assert.equal(result.uptimePercent, null);
    assert.equal(result.coveragePercent, 0);
  });
});

describe("device status history from real checks", () => {
  let server;
  let ctx;
  let listener;

  before(async () => {
    server = await startServer();
    ctx = await bootstrap(server.base);
    listener = net.createServer((socket) => socket.end());
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  });

  after(async () => {
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
    await server.close();
  });

  test("online and offline changes are recorded once each and visible to the customer", async () => {
    const { admin, custA, custB, orgA } = ctx;
    const port = listener.address().port;
    const created = await admin.post("/api/devices", { organizationId: orgA, name: "Server room switch", address: "127.0.0.1", checkPort: port });
    const id = created.data.device.id;

    assert.equal((await admin.post(`/api/devices/${id}/check`)).data.device.reachability, "online");
    assert.equal((await admin.post(`/api/devices/${id}/check`)).data.device.reachability, "online");
    await new Promise((resolve) => listener.close(resolve));
    assert.equal((await admin.post(`/api/devices/${id}/check`)).data.device.reachability, "offline");

    const report = await custA.get(`/api/devices/${id}/availability?days=7`);
    assert.equal(report.status, 200);
    assert.deepEqual(report.data.changes.map((c) => c.status), ["offline", "online"], "repeated identical results are not stored");
    assert.equal(report.data.changes[0].previousStatus, "online");
    assert.equal(report.data.source, "network_check");
    assert.equal(report.data.daily.length, 7);

    assert.equal((await custB.get(`/api/devices/${id}/availability`)).status, 404);
  });
});
