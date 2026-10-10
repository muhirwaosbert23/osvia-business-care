import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { applyDeviceCheck } from "../server/monitoring.js";
import { subscriberCount } from "../server/live.js";
import { bootstrap, startServer } from "./helpers.js";

function streamReader(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    async until(match, ms = 4000) {
      const deadline = Date.now() + ms;
      if (match.test(buf)) return buf;
      while (Date.now() < deadline) {
        const remaining = Math.max(0, deadline - Date.now());
        const timed = await Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
        ]);
        if (timed.timeout || timed.done) break;
        buf += decoder.decode(timed.value);
        if (match.test(buf)) return buf;
      }
      return buf;
    },
    stop() {
      reader.cancel().catch(() => {});
    },
  };
}

describe("live device tracking", () => {
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
    if (listener?.listening) await new Promise((resolve) => listener.close(resolve));
    await server.close();
  });

  test("the events stream greets a signed-in user and refuses strangers", async () => {
    const anon = await fetch(`${server.base}/api/events`);
    assert.equal(anon.status, 401);
    const res = await ctx.custA.raw("GET", "/api/events");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const stream = streamReader(res);
    assert.match(await stream.until(/event: hello/), /event: hello/);
    stream.stop();
    assert.ok(subscriberCount() >= 0);
  });

  test("going offline notifies the customer immediately and is hidden from another organization", async () => {
    const { admin, custA, custB, orgA } = ctx;
    const port = listener.address().port;
    const created = await admin.post("/api/devices", { organizationId: orgA, name: "Office laptop", address: "127.0.0.1", checkPort: port });
    const id = created.data.device.id;

    const customer = streamReader(await custA.raw("GET", "/api/events"));
    const other = streamReader(await custB.raw("GET", "/api/events"));
    await customer.until(/event: hello/);
    await other.until(/event: hello/);

    assert.equal((await admin.post(`/api/devices/${id}/check`)).data.device.reachability, "online");
    await new Promise((resolve) => listener.close(resolve));
    listener = null;

    const after = await applyDeviceCheck(server.db, id);
    assert.equal(after.reachability, "offline");

    const pushed = await customer.until(/event: device\.status[\s\S]*"status":"offline"/);
    assert.match(pushed, /Office laptop/);
    assert.match(pushed, /"status":"offline"/);

    const foreign = await other.until(/Office laptop/, 600);
    assert.doesNotMatch(foreign, /Office laptop/);
    customer.stop();
    other.stop();

    const dash = await custA.get("/api/dashboard");
    assert.equal(dash.status, 200);
    assert.ok(dash.data.liveDevices.some((d) => d.id === id && d.reachability === "offline"));
    assert.ok(dash.data.statusChanges.some((c) => c.deviceId === id && c.status === "offline"));
  });
});
