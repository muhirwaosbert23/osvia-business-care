import { audit, notify, notifyOrganization } from "./db.js";
import { todayUtc } from "./validate.js";

export function runReminders(db, now = new Date()) {
  const today = todayUtc(now);
  const soon = todayUtc(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
  const due = db.prepare(`
    SELECT id, name, renewal_date, subscription_status
    FROM organizations
    WHERE renewal_date IS NOT NULL AND renewal_date <= ? AND subscription_status IN ('active', 'past_due')
  `).all(soon);

  for (const org of due) {
    if (org.subscription_status === "active" && org.renewal_date < today) {
      db.prepare("UPDATE organizations SET subscription_status = 'past_due' WHERE id = ? AND subscription_status = 'active'").run(org.id);
      audit(db, null, "subscription.past_due", "organization", org.id, org.id, { renewalDate: org.renewal_date });
    }
    const marker = `renewal:${org.id}:${org.renewal_date}`;
    const title = `Renewal date ${org.renewal_date}`;
    const body = `${org.name} has a renewal date of ${org.renewal_date}. Confirm a new payment before treating the next period as paid.`;
    notifyOrganization(db, org.id, title, body, marker);
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all();
    for (const admin of admins) notify(db, admin.id, title, body, marker);
  }
}
