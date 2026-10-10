import { api, buildForm, button, clear, h, state, toast } from "./core.js";

function shell(title, subtitle, content, footer = null) {
  return h("div", { class: "auth" },
    h("aside", { class: "auth-brand" },
      h("img", { src: "/osvia-logo.jpeg", alt: "OSVIA TECH", class: "auth-logo" }),
      h("h1", {}, "OSVIA Business Care"),
      h("p", {}, "Managed IT support for organizations in Uganda: helpdesk, device care, monitoring and maintenance from OSVIA TECHNOLOGIES."),
      h("ul", { class: "auth-points" },
        h("li", {}, "Track every support request with clear response targets"),
        h("li", {}, "See device status and planned maintenance"),
        h("li", {}, "Remote support only with your recorded consent")),
      h("p", { class: "small muted-light" }, "Kampala, Uganda · ", h("a", { href: "https://osviatech.com", target: "_blank", rel: "noopener" }, "osviatech.com"))),
    h("main", { class: "auth-panel" },
      h("div", { class: "auth-card" },
        h("img", { src: "/osvia-logo.jpeg", alt: "OSVIA TECH", class: "auth-logo-small" }),
        h("h2", {}, title),
        subtitle ? h("p", { class: "muted" }, subtitle) : null,
        content,
        footer ? h("div", { class: "auth-foot" }, footer) : null)));
}

function submitForm(fields, label, onSubmit) {
  const form = buildForm(fields);
  const error = h("div", { class: "form-error", role: "alert" });
  const submit = button(label, null, { kind: "primary block", type: "submit" });
  form.el.append(error, submit);
  form.el.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    try {
      await onSubmit(form.values(), form);
    } catch (err) {
      error.textContent = err.message;
    } finally {
      if (submit.isConnected) submit.disabled = false;
    }
  });
  return form.el;
}

export function loginPage(root, onSignedIn) {
  const mfaStep = (challenge) => {
    clear(root, shell("Two-factor check", "Enter the 6-digit code from your authenticator app.", submitForm([
      { name: "code", label: "Authentication code", required: true, inputmode: "numeric", autocomplete: "one-time-code", max: 6 },
    ], "Verify", async (values) => {
      await api("POST", "/api/login/mfa", { challenge, code: values.code });
      await onSignedIn();
    }), h("a", { href: "#/login", onclick: () => setTimeout(() => loginPage(root, onSignedIn)) }, "Start again")));
    root.querySelector("input")?.focus();
  };
  clear(root, shell("Sign in", "Use the email address registered with OSVIA.", submitForm([
    { name: "email", label: "Email", type: "email", required: true, autocomplete: "username" },
    { name: "password", label: "Password", type: "password", required: true, autocomplete: "current-password" },
  ], "Sign in", async (values) => {
    const result = await api("POST", "/api/login", values);
    if (result.mfaRequired) return mfaStep(result.challenge);
    await onSignedIn();
  }), [h("span", {}, "New organization? "), h("a", { href: "#/register" }, "Register for support")]));
  root.querySelector("input")?.focus();
}

export function setupPage(root, onSignedIn, tokenRequired) {
  clear(root, shell("Create the administrator", "This first account manages OSVIA Business Care. You will set up two-factor authentication next.", submitForm([
    { name: "name", label: "Full name", required: true, max: 120, autocomplete: "name" },
    { name: "email", label: "Email", type: "email", required: true, autocomplete: "username" },
    { name: "password", label: "Password", type: "password", required: true, help: "At least 10 characters.", autocomplete: "new-password" },
    tokenRequired ? { name: "setupToken", label: "Setup token", type: "password", required: true, help: "The SETUP_TOKEN value from the server configuration." } : null,
  ].filter(Boolean), "Create administrator", async (values) => {
    await api("POST", "/api/setup", values);
    await onSignedIn();
  })));
}

export function registerPage(root) {
  clear(root, shell("Register your organization", "OSVIA reviews every registration before support starts.", submitForm([
    { name: "organizationName", label: "Organization name", required: true, max: 160 },
    { name: "contactName", label: "Your name", required: true, max: 120, autocomplete: "name" },
    { name: "email", label: "Work email", type: "email", required: true, autocomplete: "username" },
    { name: "phone", label: "Phone", type: "tel", max: 40, autocomplete: "tel", placeholder: "+256 7XX XXX XXX" },
    { name: "location", label: "Location", max: 160, placeholder: "e.g. Ntinda, Kampala" },
    { name: "password", label: "Password", type: "password", required: true, help: "At least 10 characters.", autocomplete: "new-password" },
  ], "Register", async (values) => {
    await api("POST", "/api/register", values);
    toast("Registration received. Sign in to follow the approval.");
    location.hash = "#/login";
  }), [h("span", {}, "Already registered? "), h("a", { href: "#/login" }, "Sign in")]));
}

export async function invitePage(root, token, onSignedIn) {
  clear(root, shell("Accept invitation", "Checking your invitation…", h("div", { class: "skeleton" })));
  let invite;
  try {
    invite = await api("POST", "/api/invitations/inspect", { token });
  } catch (error) {
    clear(root, shell("Invitation not valid", error.message, h("a", { class: "btn primary block", href: "#/login" }, "Go to sign in")));
    return;
  }
  clear(root, shell("Accept invitation", `You were invited to ${invite.organizationName} as ${invite.roleLabel}.`, submitForm([
    { name: "email", label: "Email", value: invite.email, type: "email", help: "This is fixed by the invitation." },
    { name: "name", label: "Full name", value: invite.name, required: true, max: 120, autocomplete: "name" },
    { name: "phone", label: "Phone", type: "tel", max: 40 },
    { name: "password", label: "Choose a password", type: "password", required: true, help: "At least 10 characters.", autocomplete: "new-password" },
  ], "Create my account", async (values) => {
    await api("POST", "/api/invitations/accept", { token, name: values.name, phone: values.phone, password: values.password });
    history.replaceState(null, "", "#/dashboard");
    await onSignedIn();
  })));
  const email = root.querySelector("input[type=email]");
  if (email) email.readOnly = true;
  state.me = null;
}
