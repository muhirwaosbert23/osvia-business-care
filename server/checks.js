import { notifyStaff } from "./db.js";
import { probe } from "./probe.js";
import { nowIso } from "./validate.js";

const DEVICE_ROW = `
  SELECT d.*, o.name AS organization_name
  FROM devices d JOIN organizations o ON o.id = d.organization_id
  WHERE d.id = ?
`;

export async function applyDeviceCheck(db, deviceId) {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId);
  if (!device) return null;
  if (!device.address) {
    db.prepare("UPDATE devices SET reachability = 'unknown', last_checked = NULL WHERE id = ?").run(deviceId);
    return db.prepare(DEVICE_ROW).get(deviceId);
  }
  const reachability = await probe(device.address, device.check_port);
  const checkedAt = nowIso();
  const lastConnection = reachability === "online" ? checkedAt : device.last_connection;
  db.prepare("UPDATE devices SET reachability = ?, last_checked = ?, last_connection = ? WHERE id = ?").run(
    reachability,
    checkedAt,
    lastConnection,
    deviceId,
  );
  if (device.reachability !== "offline" && reachability === "offline") {
    notifyStaff(db, `${device.name} is offline`, `A check to ${device.address} did not succeed.`);
  }
  if (device.reachability === "offline" && reachability === "online") {
    notifyStaff(db, `${device.name} is online`, `A check to ${device.address} succeeded.`);
  }
  return db.prepare(DEVICE_ROW).get(deviceId);
}

export async function refreshDevices(db) {
  const rows = db.prepare("SELECT id FROM devices WHERE address IS NOT NULL AND trim(address) != ''").all();
  for (const row of rows) {
    await applyDeviceCheck(db, row.id);
  }
}
