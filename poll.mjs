// Polls Calendly for new / canceled bookings and alerts by email + WhatsApp.
// Runs on GitHub Actions every 5 minutes (see .github/workflows/poll.yml).
// State (which events we have already alerted on) lives in state.json and is
// committed back to the repo by the workflow.
//
// Secrets (GitHub Actions secrets, never in code):
//   CALENDLY_TOKEN        Calendly personal access token
//   CALENDLY_USER_URI     https://api.calendly.com/users/<uuid>
//   GMAIL_USER            gmail address that SENDS (needs an App Password)
//   GMAIL_APP_PASSWORD    16-char Google App Password for GMAIL_USER
//   ALERT_EMAIL_TO        where alerts go (default: GMAIL_USER)
//   CALLMEBOT_PHONE       WhatsApp number in E.164, e.g. +8190xxxxxxxx
//   CALLMEBOT_APIKEY      key CallMeBot sends you after activation
// GITHUB_TOKEN / GITHUB_REPOSITORY are provided by Actions: every alert also
// becomes a GitHub issue, and GitHub emails the repo owner about it.
// Optional: DRY_RUN=1 prints alerts instead of sending; ALERT_TZ (default Asia/Tokyo).

import fs from "node:fs";
import nodemailer from "nodemailer";

const {
  CALENDLY_TOKEN, CALENDLY_USER_URI,
  GMAIL_USER, GMAIL_APP_PASSWORD, ALERT_EMAIL_TO,
  CALLMEBOT_PHONE, CALLMEBOT_APIKEY,
  GITHUB_TOKEN, GITHUB_REPOSITORY,
  DRY_RUN, ALERT_TZ = "Asia/Tokyo",
} = process.env;

if (!CALENDLY_TOKEN || !CALENDLY_USER_URI) {
  console.error("CALENDLY_TOKEN and CALENDLY_USER_URI are required");
  process.exit(1);
}

const STATE_FILE = "state.json";
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { events: {} };
const firstRun = Object.keys(state.events).length === 0 && !state.initialized;

const cal = async (path) => {
  const r = await fetch(`https://api.calendly.com${path}`, { headers: { Authorization: `Bearer ${CALENDLY_TOKEN}` } });
  if (!r.ok) throw new Error(`Calendly ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// Everything from 2 days ago onward, newest start first. Bookings are created
// at most a few weeks out, so 100 covers it; paginate if there is more.
const since = new Date(Date.now() - 2 * 24 * 3600e3).toISOString();
let url = `/scheduled_events?user=${encodeURIComponent(CALENDLY_USER_URI)}&min_start_time=${since}&sort=start_time:desc&count=100`;
const events = [];
while (url) {
  const page = await cal(url);
  events.push(...page.collection);
  url = page.pagination?.next_page ? page.pagination.next_page.replace("https://api.calendly.com", "") : null;
}

const fmt = (iso, tz) => new Date(iso).toLocaleString("en-US", {
  timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

const alerts = [];
for (const ev of events) {
  const uuid = ev.uri.split("/").pop();
  const prev = state.events[uuid];
  if (prev && prev.status === ev.status) continue;

  // First ever run: record what exists without alerting on the backlog.
  if (firstRun) { state.events[uuid] = { status: ev.status, start: ev.start_time }; continue; }

  const inv = (await cal(`/scheduled_events/${uuid}/invitees`)).collection[0] || {};
  const qa = (inv.questions_and_answers || []).map((q) => `${q.question}: ${q.answer}`).join("\n");
  const kind = ev.status === "canceled" ? "CANCELED" : "NEW BOOKING";
  const lines = [
    `${kind}: ${ev.name}`,
    `${inv.name || "?"} <${inv.email || "?"}>`,
    `${fmt(ev.start_time, ALERT_TZ)}  (${fmt(ev.start_time, "America/New_York")})`,
    inv.text_reminder_number ? `Phone: ${inv.text_reminder_number}` : null,
    qa || null,
    ev.status === "canceled" && ev.cancellation ? `Reason: ${ev.cancellation.reason || "none given"} (by ${ev.cancellation.canceler_type})` : null,
    inv.reschedule_url ? `Reschedule: ${inv.reschedule_url}` : null,
    ev.location?.join_url ? `Join: ${ev.location.join_url}` : null,
  ].filter(Boolean);
  alerts.push({ subject: `${kind}: ${inv.name || "?"} on ${fmt(ev.start_time, ALERT_TZ)}`, text: lines.join("\n") });
  state.events[uuid] = { status: ev.status, start: ev.start_time };
}

// Forget events that started more than 30 days ago so state.json stays small.
const cutoff = Date.now() - 30 * 24 * 3600e3;
for (const [k, v] of Object.entries(state.events)) if (new Date(v.start).getTime() < cutoff) delete state.events[k];
state.initialized = true;
state.last_run = new Date().toISOString();

async function sendEmail(a) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return "email: skipped (no GMAIL_* secrets)";
  const t = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  await t.sendMail({ from: `Calendly Alert <${GMAIL_USER}>`, to: ALERT_EMAIL_TO || GMAIL_USER, subject: a.subject, text: a.text });
  return "email: sent";
}
// Zero-credential email: open a GitHub issue. GitHub emails the repo owner the
// full body (issues are created by the Actions bot, so the owner is notified).
async function sendIssue(a) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return "issue: skipped (not on Actions)";
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ title: a.subject, body: "```\n" + a.text + "\n```", labels: [a.text.startsWith("CANCELED") ? "canceled" : "booking"] }),
  });
  return `issue: ${r.status}${r.ok ? " " + (await r.json()).html_url : " " + (await r.text()).slice(0, 100)}`;
}
async function sendWhatsApp(a) {
  if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) return "whatsapp: skipped (no CALLMEBOT_* secrets)";
  const u = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(CALLMEBOT_PHONE)}&apikey=${encodeURIComponent(CALLMEBOT_APIKEY)}&text=${encodeURIComponent(a.text)}`;
  const r = await fetch(u);
  return `whatsapp: ${r.status} ${(await r.text()).slice(0, 80).replace(/\s+/g, " ")}`;
}

console.log(`${events.length} events checked, ${alerts.length} alert(s)${firstRun ? " (first run: baseline only)" : ""}`);
for (const a of alerts) {
  console.log("----\n" + a.text);
  if (DRY_RUN) { console.log("(dry run, not sent)"); continue; }
  console.log(await sendIssue(a).catch((e) => `issue: FAILED ${e.message}`));
  console.log(await sendEmail(a).catch((e) => `email: FAILED ${e.message}`));
  console.log(await sendWhatsApp(a).catch((e) => `whatsapp: FAILED ${e.message}`));
}
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
