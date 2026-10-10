import { securityHeaders } from "./http.js";
import { nowIso } from "./validate.js";

const subscribers = new Map();
const KEEPALIVE_MS = 20000;

function drop(userId, res) {
  const set = subscribers.get(userId);
  if (!set) return;
  set.delete(res);
  if (!set.size) subscribers.delete(userId);
}

export function publish(userIds, type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const userId of new Set((userIds || []).filter(Boolean))) {
    const set = subscribers.get(userId);
    if (!set) continue;
    for (const res of [...set]) {
      try {
        res.write(payload);
      } catch {
        drop(userId, res);
      }
    }
  }
}

export function subscriberCount() {
  let n = 0;
  for (const set of subscribers.values()) n += set.size;
  return n;
}

export function events({ req, res, actor }) {
  req.setTimeout(0);
  res.setTimeout(0);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...securityHeaders(),
  });
  res.write("retry: 3000\n");
  res.write(`event: hello\ndata: ${JSON.stringify({ at: nowIso() })}\n\n`);
  let set = subscribers.get(actor.id);
  if (!set) {
    set = new Set();
    subscribers.set(actor.id, set);
  }
  set.add(res);
  const ping = setInterval(() => {
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      clearInterval(ping);
      drop(actor.id, res);
    }
  }, KEEPALIVE_MS);
  ping.unref();
  const cleanup = () => {
    clearInterval(ping);
    drop(actor.id, res);
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

export const routes = [
  ["GET", "/api/events", events, { stream: true }],
];
