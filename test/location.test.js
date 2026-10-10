import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { googleMapsUrl, nodeCoordinates, nodePublicIp, parseCoords } from "../server/geo.js";
import { metersBetween } from "../server/location.js";
import { bootstrap, startServer } from "./helpers.js";

const KAMPALA = { lat: 0.3476, lng: 32.5825, label: "Industrial Area, Kampala" };
const ENTEBBE = { lat: 0.0512, lng: 32.4637, label: "Entebbe" };

function fakeLookup(url) {
  if (String(url).includes("ipwho.is/8.8.8.8") || String(url).includes("ipwho.is/1.2.3.4")) {
    return { ok: true, json: async () => ({ success: true, latitude: 0.3476, longitude: 32.5825, city: "Kampala", region: "Central", country: "Uganda" }) };
  }
  if (String(url).includes("nominatim.openstreetmap.org")) {
    return { ok: true, json: async () => [{ lat: "0.3136", lon: "32.5811", display_name: "Kampala, Central Region, Uganda" }] };
  }
  return { ok: false, json: async () => ({}) };
}

describe("coordinates", () => {
  test("rejects values that are not on the earth", () => {
    assert.throws(() => parseCoords(91, 32), /valid latitude/);
    assert.throws(() => parseCoords(0.3, "east"), /valid latitude/);
  });

  test("Google Maps URL uses the pin", () => {
    assert.equal(googleMapsUrl(KAMPALA), "https://www.google.com/maps?q=0.3476,32.5825");
  });

  test("Kampala to Entebbe is a real move, not city-level noise", () => {
    assert.ok(metersBetween(KAMPALA, ENTEBBE) > 20000);
  });

  test("MeshCentral GPS is read from the fields MeshCentral actually sends", () => {
    assert.deepEqual(nodeCoordinates({ lat: 0.3476, long: 32.5825 }).source, "meshcentral");
    assert.equal(nodeCoordinates({ gps: { latitude: 0.3136, longitude: 32.5811, accuracy: 18 } }).accuracyM, 18);
    assert.equal(nodeCoordinates({ iploc: "0.0512,32.4637" }).lat, 0.0512);
    assert.equal(nodeCoordinates({ lat: 0, lon: 0 }), null, "0,0 is no GPS fix");
    assert.equal(nodePublicIp({ ip: "10.0.0.8", host: "1.2.3.4" }), "1.2.3.4");
    assert.equal(nodePublicIp({ ip: "192.168.1.10", host: "10.0.0.2" }), null);
  });
});

describe("staff Google Maps location", () => {
  let server;
  let ctx;
  let deviceId;

  before(async () => {
    server = await startServer({ lookupFetch: fakeLookup });
    ctx = await bootstrap(server.base);
    const created = await ctx.admin.post("/api/devices", { organizationId: ctx.orgA, name: "Accounts laptop", address: "8.8.8.8" });
    assert.equal(created.status, 201);
    deviceId = created.data.device.id;
  });

  after(() => server.close());

  test("customers cannot read coordinates or the fleet map", async () => {
    const shown = await ctx.custA.get(`/api/devices/${deviceId}`);
    assert.equal(shown.status, 200);
    assert.equal(shown.data.device.location, undefined);
    assert.equal(shown.data.device.hasLocation, undefined);
    assert.equal((await ctx.custA.get(`/api/devices/${deviceId}/location`)).status, 403);
    assert.equal((await ctx.custA.post(`/api/devices/${deviceId}/location`, KAMPALA)).status, 403);
    assert.equal((await ctx.custA.get("/api/devices/map")).status, 403);
    assert.equal((await ctx.custB.get(`/api/devices/${deviceId}/location`)).status, 403);
  });

  test("a private address cannot be placed on a public map", async () => {
    const local = await ctx.admin.post("/api/devices", { organizationId: ctx.orgA, name: "Office switch", address: "192.168.1.10" });
    const res = await ctx.admin.post(`/api/devices/${local.data.device.id}/locate`, {});
    assert.equal(res.status, 400);
    assert.match(res.data.error, /Private or local/);
  });

  test("admin can pin Kampala, open Google Maps, and see movement", async () => {
    const pin = await ctx.admin.post(`/api/devices/${deviceId}/location`, { ...KAMPALA, source: "manual" });
    assert.equal(pin.status, 200);
    assert.equal(pin.data.location.lat, KAMPALA.lat);
    assert.match(pin.data.location.mapsUrl, /google\.com\/maps\?q=0\.3476,32\.5825/);
    assert.match(pin.data.location.embedUrl, /google\.com\/maps\?q=0\.3476,32\.5825/);
    assert.equal(pin.data.device.location.lat, KAMPALA.lat);

    const again = await ctx.admin.post(`/api/devices/${deviceId}/location`, { ...KAMPALA, source: "manual" });
    assert.equal(again.data.location.recorded, false);

    const moved = await ctx.admin.post(`/api/devices/${deviceId}/location`, { ...ENTEBBE, source: "manual" });
    assert.equal(moved.data.location.recorded, true);

    const hist = await ctx.admin.get(`/api/devices/${deviceId}/location`);
    assert.equal(hist.status, 200);
    assert.equal(hist.data.items.length, 2);
    assert.equal(hist.data.items[0].label, ENTEBBE.label);
    assert.match(hist.data.pathUrl, /google\.com\/maps\/dir\//);

    const fleet = await ctx.admin.get("/api/devices/map");
    assert.equal(fleet.status, 200);
    assert.ok(fleet.data.items.some((item) => item.id === deviceId && item.location.mapsUrl.includes("0.0512")));
  });

  test("technicians can look up a public IP and a place without calling the live APIs", async () => {
    const ip = await ctx.tech.post(`/api/devices/${deviceId}/locate`, { ip: "1.2.3.4" });
    assert.equal(ip.status, 200);
    assert.equal(ip.data.location.source, "ip");
    assert.match(ip.data.location.label, /Kampala/);
    assert.match(ip.data.notice, /not the room/);

    const place = await ctx.tech.post(`/api/devices/${deviceId}/locate`, { place: "Kampala" });
    assert.equal(place.status, 200);
    assert.equal(place.data.location.source, "manual");
    assert.match(place.data.location.label, /Kampala/);
  });

  test("invalid coordinates are rejected", async () => {
    const res = await ctx.admin.post(`/api/devices/${deviceId}/location`, { lat: 120, lng: 32 });
    assert.equal(res.status, 400);
  });

  test("opening the map detects a public address automatically", async () => {
    const created = await ctx.admin.post("/api/devices", { organizationId: ctx.orgA, name: "WAN printer", address: "1.2.3.4" });
    const refreshed = await ctx.admin.post("/api/devices/map/refresh");
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.data.items.some((item) => item.id === created.data.device.id && item.location.source === "ip"));
    assert.equal((await ctx.custA.post("/api/devices/map/refresh")).status, 403);
  });
});
