import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import { totpCode } from "../server/security.js";

export const PASSWORD = "Correct-Horse-42";

export async function startServer(services = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "osvia-test-"));
  process.env.DATA_DIR = dataDir;
  const db = openDatabase(":memory:");
  const server = createApp(db, services);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    base,
    dataDir,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = "";
    this.csrf = "";
  }

  async raw(method, url, { body, headers = {}, rawBody } = {}) {
    const init = { method, headers: { ...headers }, redirect: "manual" };
    if (this.cookie) init.headers.Cookie = this.cookie;
    if (this.csrf && method !== "GET") init.headers["X-CSRF-Token"] = this.csrf;
    if (rawBody !== undefined) init.body = rawBody;
    else if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(this.base + url, init);
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const value = setCookie.split(";")[0];
      this.cookie = value.endsWith("=") ? "" : value;
    }
    return res;
  }

  async call(method, url, body, options = {}) {
    const res = await this.raw(method, url, { body, ...options });
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
    if (data && data.csrfToken) this.csrf = data.csrfToken;
    return { status: res.status, data, headers: res.headers };
  }

  get(url) {
    return this.call("GET", url);
  }

  post(url, body = {}) {
    return this.call("POST", url, body);
  }

  patch(url, body = {}) {
    return this.call("PATCH", url, body);
  }

  async login(email, password = PASSWORD, secret = null) {
    const first = await this.post("/api/login", { email, password });
    if (first.status !== 200) return first;
    if (!first.data.mfaRequired) return first;
    return this.post("/api/login/mfa", { challenge: first.data.challenge, code: totpCode(secret) });
  }

  async enrollMfa() {
    const start = await this.post("/api/me/mfa/start");
    const confirm = await this.post("/api/me/mfa/confirm", { code: totpCode(start.data.secret) });
    if (confirm.status !== 200) throw new Error(`MFA enrollment failed: ${JSON.stringify(confirm.data)}`);
    return start.data.secret;
  }
}

export function inviteToken(link) {
  return link.split("/#/invite/")[1];
}

export async function bootstrap(base) {
  const admin = new Client(base);
  const setup = await admin.post("/api/setup", { name: "Admin", email: "admin@osvia.test", password: PASSWORD });
  if (setup.status !== 200) throw new Error(`setup failed ${JSON.stringify(setup.data)}`);
  const adminSecret = await admin.enrollMfa();

  async function invite(role, email, organizationId) {
    const res = await admin.post("/api/invitations", { role, email, organizationId, name: email.split("@")[0] });
    if (res.status !== 201) throw new Error(`invite failed ${JSON.stringify(res.data)}`);
    const client = new Client(base);
    const accepted = await client.post("/api/invitations/accept", { token: inviteToken(res.data.link), name: email.split("@")[0], password: PASSWORD });
    if (accepted.status !== 200) throw new Error(`accept failed ${JSON.stringify(accepted.data)}`);
    return client;
  }

  const tech = await invite("technician", "tech@osvia.test");
  const techSecret = await tech.enrollMfa();

  async function organization(name) {
    const res = await admin.post("/api/organizations", { name, contactName: `${name} Owner`, contactEmail: `owner@${name.toLowerCase()}.test` });
    if (res.status !== 201) throw new Error(`org failed ${JSON.stringify(res.data)}`);
    return res.data.organization.id;
  }

  const orgA = await organization("Alpha");
  const orgB = await organization("Bravo");
  const custA = await invite("customer_admin", "admin@alpha.test", orgA);
  const userA = await invite("customer_user", "user@alpha.test", orgA);
  const custB = await invite("customer_admin", "admin@bravo.test", orgB);
  return { admin, adminSecret, tech, techSecret, orgA, orgB, custA, userA, custB, invite };
}
