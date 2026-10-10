import fs from "node:fs";
import path from "node:path";
import { backupDatabase, pruneBackups } from "./backup.js";
import { getSetting, setHealth, transaction } from "./db.js";
import { refreshDeviceLocations } from "./location.js";
import { meshConfigured, syncDevices } from "./meshcentral.js";
import { meshIncidents, refreshDevices, runDueMonitors } from "./monitoring.js";
import { customerAdminIds, deliverOutbox, notifyUsers, staffIds } from "./notify.js";
import { addBusinessMinutes, loadHolidays, slaState } from "./sla.js";
import { addDays, todayUtc } from "./validate.js";

const ACTIVE = "('new','open','in_progress','pending_customer')";

export function evaluateSla(db, now = new Date()) {
  const nowText = now.toISOString();
  const holidays = loadHolidays(db);
  const rows = db.prepare(`
    SELECT t.*, p.response_minutes, p.resolution_minutes, p.escalate_at_percent, p.business_hours_only, p.timezone, p.business_start, p.business_end, p.business_days, p.exclude_holidays
    FROM tickets t JOIN sla_policies p ON p.id = t.sla_policy_id
    WHERE t.status IN ${ACTIVE}
  `).all();
  let breaches = 0;
  let escalations = 0;
  for (const ticket of rows) {
    const sla = slaState(ticket, nowText);
    const responseBreached = sla.response === "breached" ? 1 : 0;
    const resolutionBreached = sla.resolution === "breached" ? 1 : 0;
    const recipients = [...staffIds(db, ["admin"]), ticket.assigned_to];
    transaction(db, () => {
      if (responseBreached !== ticket.response_breached || resolutionBreached !== ticket.resolution_breached) {
        db.prepare("UPDATE tickets SET response_breached = ?, resolution_breached = ? WHERE id = ?").run(responseBreached, resolutionBreached, ticket.id);
      }
      if (responseBreached && !ticket.response_breached) {
        breaches += 1;
        notifyUsers(db, recipients, { title: `SLA breached: no first response on ${ticket.number}`, body: `${ticket.title}. The response target was ${ticket.response_due_at}.`, kind: "sla", link: `tickets/${ticket.id}`, marker: `sla-response:${ticket.id}` });
      }
      if (resolutionBreached && !ticket.resolution_breached) {
        breaches += 1;
        notifyUsers(db, recipients, { title: `SLA breached: ${ticket.number} not resolved in time`, body: `${ticket.title}. The resolution target was ${ticket.resolution_due_at}.`, kind: "sla", link: `tickets/${ticket.id}`, marker: `sla-resolution:${ticket.id}` });
      }
      if (!ticket.escalated_at && !ticket.sla_paused_at) {
        const start = Date.parse(ticket.created_at);
        let threshold = null;
        if (!ticket.first_response_at) threshold = addBusinessMinutes(start, Math.ceil((ticket.response_minutes * ticket.escalate_at_percent) / 100), ticket, holidays);
        else if (ticket.resolution_minutes) threshold = addBusinessMinutes(start, Math.ceil((ticket.resolution_minutes * ticket.escalate_at_percent) / 100), ticket, holidays);
        if (threshold !== null && now.getTime() >= threshold) {
          escalations += 1;
          db.prepare("UPDATE tickets SET escalated_at = ? WHERE id = ?").run(nowText, ticket.id);
          db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, from_status, to_status, note, created_at) VALUES (?, NULL, ?, ?, ?, ?)").run(ticket.id, ticket.status, ticket.status, `internal:Escalated at ${ticket.escalate_at_percent}% of the SLA target`, nowText);
          notifyUsers(db, recipients, { title: `Escalation: ${ticket.number} is close to its SLA target`, body: `${ticket.priority.toUpperCase()} - ${ticket.title}`, kind: "sla", link: `tickets/${ticket.id}`, marker: `sla-escalate:${ticket.id}` });
        }
      }
    });
  }
  return { checked: rows.length, breaches, escalations };
}

export function autoCloseResolved(db, now = new Date()) {
  const days = Number(getSetting(db, "auto_close_days", "7")) || 7;
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString();
  const rows = db.prepare("SELECT id, status FROM tickets WHERE status = 'resolved' AND resolved_at <= ?").all(cutoff);
  for (const row of rows) {
    transaction(db, () => {
      db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'resolved'").run(now.toISOString(), now.toISOString(), row.id);
      db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, from_status, to_status, note, created_at) VALUES (?, NULL, 'resolved', 'closed', ?, ?)").run(row.id, `Closed automatically after ${days} days without a reply`, now.toISOString());
    });
  }
  return rows.length;
}

export function maintenanceReminders(db, now = new Date()) {
  const today = todayUtc(now);
  const rows = db.prepare(`
    SELECT s.*, o.name AS organization_name FROM maintenance_schedules s JOIN organizations o ON o.id = s.organization_id
    WHERE s.active = 1 AND o.status = 'active' AND s.next_due <= ? AND (s.reminder_sent_for IS NULL OR s.reminder_sent_for != s.next_due)
  `).all(addDays(today, 3));
  for (const s of rows) {
    const overdue = s.next_due < today;
    transaction(db, () => {
      const recipients = s.assigned_to ? [s.assigned_to, ...staffIds(db, ["admin"])] : staffIds(db);
      notifyUsers(db, recipients, { title: `${overdue ? "Overdue" : "Due soon"}: ${s.title}`, body: `${s.organization_name}, due ${s.next_due}.`, kind: "maintenance", link: "maintenance", marker: `maintenance:${s.id}:${s.next_due}` });
      notifyUsers(db, customerAdminIds(db, s.organization_id), { title: `Planned maintenance: ${s.title}`, body: `OSVIA plans this work on or before ${s.next_due}.`, kind: "maintenance", link: "maintenance", marker: `maintenance-customer:${s.id}:${s.next_due}` });
      db.prepare("UPDATE maintenance_schedules SET reminder_sent_for = next_due WHERE id = ?").run(s.id);
    });
  }
  return rows.length;
}

export function billingJobs(db, now = new Date()) {
  const today = todayUtc(now);
  let changed = 0;
  for (const org of db.prepare("SELECT id, name, renewal_date FROM organizations WHERE subscription_status = 'active' AND renewal_date IS NOT NULL AND renewal_date <= ?").all(addDays(today, 7))) {
    const lapsed = org.renewal_date < today;
    transaction(db, () => {
      if (lapsed) {
        db.prepare("UPDATE organizations SET subscription_status = 'past_due' WHERE id = ? AND subscription_status = 'active'").run(org.id);
        db.prepare("INSERT INTO subscription_events (organization_id, from_status, to_status, plan_id, actor_id, note, created_at) VALUES (?, 'active', 'past_due', NULL, NULL, ?, ?)").run(org.id, `Renewal date ${org.renewal_date} passed without a verified payment`, now.toISOString());
        changed += 1;
      }
      notifyUsers(db, customerAdminIds(db, org.id), {
        title: lapsed ? "Subscription renewal overdue" : "Subscription renews soon",
        body: lapsed ? `Your plan renewal was due ${org.renewal_date}. Pay the renewal invoice to keep full service.` : `Your plan renews on ${org.renewal_date}.`,
        kind: "billing",
        link: "billing",
        marker: `renewal:${org.id}:${org.renewal_date}:${lapsed ? "lapsed" : "soon"}`,
      });
      if (lapsed) notifyUsers(db, staffIds(db, ["admin"]), { title: `${org.name} is past due`, body: `Renewal date ${org.renewal_date}.`, kind: "billing", link: `organizations/${org.id}`, marker: `renewal-staff:${org.id}:${org.renewal_date}` });
    });
  }
  for (const invoice of db.prepare("SELECT * FROM invoices WHERE status = 'issued' AND due_date < ?").all(today)) {
    notifyUsers(db, customerAdminIds(db, invoice.organization_id), { title: `Invoice ${invoice.number} is overdue`, body: `It was due ${invoice.due_date}.`, kind: "billing", link: "billing", marker: `invoice-overdue:${invoice.id}` });
  }
  return changed;
}

export function monthlyReportNotices(db, now = new Date()) {
  const today = todayUtc(now);
  if (today.slice(8, 10) !== "01") return 0;
  const month = addDays(today, -1).slice(0, 7);
  const orgs = db.prepare("SELECT id FROM organizations WHERE status = 'active'").all();
  for (const org of orgs) {
    notifyUsers(db, customerAdminIds(db, org.id), { title: `Your ${month} service report is ready`, body: "Open Reports and download the PDF for last month.", kind: "report", link: `reports?from=${month}-01&to=${addDays(today, -1)}`, marker: `monthly-report:${org.id}:${month}` });
  }
  return orgs.length;
}

export function pruneData(db, now = new Date()) {
  const iso = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < ?").run(iso(1));
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
  db.prepare("DELETE FROM mfa_challenges WHERE expires_at < ?").run(now.toISOString());
  db.prepare("DELETE FROM monitor_checks WHERE checked_at < ?").run(iso(Number(process.env.MONITOR_HISTORY_DAYS || 90)));
  db.prepare("DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?").run(iso(180));
  db.prepare("DELETE FROM email_outbox WHERE status IN ('sent', 'skipped') AND created_at < ?").run(iso(30));
}

function nightlyBackup(db, backupDir) {
  const marker = path.join(backupDir, ".last-nightly");
  const last = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) : 0;
  if (Date.now() - last < 23 * 3600000) return null;
  const file = backupDatabase(db, backupDir, { label: "osvia-nightly" });
  fs.writeFileSync(marker, String(Date.now()));
  pruneBackups(backupDir, Number(process.env.BACKUP_KEEP || 14));
  setHealth(db, "backup", "ok", `Last backup ${path.basename(file)}${process.env.BACKUP_KEY ? " (encrypted)" : " (not encrypted: set BACKUP_KEY)"}.`);
  return file;
}

export function startScheduler(db, { backupDir }) {
  const running = new Set();
  const timers = [];
  const every = (name, ms, task, { immediate = true } = {}) => {
    const run = async () => {
      if (running.has(name)) return;
      running.add(name);
      try {
        await task();
      } catch (error) {
        console.error(new Date().toISOString(), `job ${name} failed:`, error.message);
        try {
          setHealth(db, name === "outbox" ? "smtp" : name, "error", error.message);
        } catch {
          /* the database itself may be unavailable */
        }
      } finally {
        running.delete(name);
      }
    };
    if (immediate) setTimeout(run, 2000).unref();
    const timer = setInterval(run, ms);
    timer.unref();
    timers.push(timer);
  };

  every("devices", 15000, async () => {
    const n = await refreshDevices(db);
    setHealth(db, "device_runner", "ok", `Checked ${n} device(s).`);
  });
  every("scheduler", 60000, async () => {
    await runDueMonitors(db);
    evaluateSla(db);
    setHealth(db, "scheduler", "ok", "Background checks ran.");
  });
  every("outbox", 30000, () => deliverOutbox(db));
  every("hourly", 3600000, async () => {
    autoCloseResolved(db);
    maintenanceReminders(db);
    billingJobs(db);
    monthlyReportNotices(db);
    pruneData(db);
    await refreshDeviceLocations(db, { limit: 30 });
  });
  every("backup", 3600000, () => nightlyBackup(db, backupDir));
  if (meshConfigured()) {
    every("meshcentral", Number(process.env.MESH_SYNC_MINUTES || 5) * 60000, async () => {
      const result = await syncDevices(db);
      if (result.status === "ok") meshIncidents(db);
    });
  }
  return {
    stop() {
      for (const timer of timers) clearInterval(timer);
    },
    idle() {
      return running.size === 0;
    },
  };
}
