import { spawn } from "node:child_process";
import net from "node:net";
import { HttpError } from "./errors.js";

export function assertHost(value) {
  const host = String(value || "").trim();
  if (!host) return "";
  if (host.length > 253 || !/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
    throw new HttpError(400, "Enter an IP address or hostname.");
  }
  if (host === "0.0.0.0" || host === "169.254.169.254") {
    throw new HttpError(400, "That address cannot be checked.");
  }
  return host;
}

export function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function pingHost(host) {
  return new Promise((resolve) => {
    const args = process.platform === "win32" ? ["-n", "1", "-w", "1500", host] : ["-c", "1", "-W", "2", host];
    const child = spawn("ping", args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 3000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export async function probe(host, port) {
  if (port) return (await tcpOpen(host, port, 2000)) ? "online" : "offline";
  if (await pingHost(host)) return "online";
  if (await tcpOpen(host, 445, 1500)) return "online";
  return "offline";
}
