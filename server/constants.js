export const STAFF_ROLES = ["admin", "technician"];
export const CUSTOMER_ROLES = ["customer_admin", "customer_user"];
export const ROLES = [...STAFF_ROLES, ...CUSTOMER_ROLES];

export const TICKET_STATUSES = ["new", "open", "in_progress", "pending_customer", "resolved", "closed"];
export const ACTIVE_TICKET_STATUSES = ["new", "open", "in_progress", "pending_customer"];
export const PRIORITIES = ["low", "normal", "high", "urgent"];
export const IMPACTS = ["single_user", "team", "organization"];
export const CATEGORIES = ["hardware", "software", "network", "email", "printer", "security", "account_access", "other"];

export const STAFF_TRANSITIONS = {
  new: ["open", "in_progress", "pending_customer", "resolved"],
  open: ["in_progress", "pending_customer", "resolved"],
  in_progress: ["open", "pending_customer", "resolved"],
  pending_customer: ["open", "in_progress", "resolved"],
  resolved: ["closed", "open"],
  closed: ["open"],
};

export const ASSET_TYPES = ["computer", "laptop", "server", "printer", "network", "phone", "other"];
export const CONDITIONS = ["unknown", "good", "fair", "poor"];
export const OPERATIONAL_STATUSES = ["in_service", "in_repair", "spare", "retired"];

export const PAYMENT_METHODS = ["cash", "bank_transfer", "mobile_money_manual", "cheque", "other"];
export const SUBSCRIPTION_STATUSES = ["unpaid", "active", "past_due", "suspended", "cancelled"];

export const ROLE_LABELS = {
  admin: "Super administrator",
  technician: "IT technician",
  customer_admin: "Customer administrator",
  customer_user: "Customer user",
};
