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
//   DISCORD_WEBHOOK_URL   Discord channel webhook (phone push via the Discord app)
// GITHUB_TOKEN / GITHUB_REPOSITORY are provided by Actions: every alert also
// becomes a GitHub issue, and GitHub emails the repo owner about it.
// Optional: DRY_RUN=1 prints alerts instead of sending; ALERT_TZ (default Asia/Tokyo).

import fs from "node:fs";
import nodemailer from "nodemailer";

const {
  CALENDLY_TOKEN, CALENDLY_USER_URI,
  GMAIL_USER, GMAIL_APP_PASSWORD, ALERT_EMAIL_TO,
  CALLMEBOT_PHONE, CALLMEBOT_APIKEY,
  GITHUB_TOKEN, GITHUB_REPOSITORY, DISCORD_WEBHOOK_URL,
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
  const canceled = ev.status === "canceled";
  const kind = canceled ? "CANCELED" : "NEW BOOKING";
  const when = {
    you: fmt(ev.start_time, ALERT_TZ),
    ny: fmt(ev.start_time, "America/New_York"),
    them: inv.timezone ? fmt(ev.start_time, inv.timezone) : null,
    end: ev.end_time,
  };
  const zoom = ev.location?.join_url || null;
  const qa = (inv.questions_and_answers || []).filter((q) => (q.answer || "").trim());
  const a = { kind, event: ev.name, inv, when, zoom, qa, cancellation: canceled ? ev.cancellation : null, uuid };

  // Markdown (GitHub issue + email). Mirrors Calendly's own notification layout.
  const md = [];
  md.push(`@${(GITHUB_REPOSITORY || "/").split("/")[0]}`, "");
  md.push(`## ${canceled ? "Event canceled" : "A new event has been scheduled"}`, "");
  md.push(`**Event Type:** ${ev.name}`, "");
  md.push(`**Invitee:** ${inv.name || "?"}`, "");
  md.push(`**Invitee Email:** ${inv.email || "?"}`, "");
  if (inv.text_reminder_number) md.push(`**Phone:** ${inv.text_reminder_number}`, "");
  md.push(`**Event Date/Time:**`, `- ${when.you} (your time)`, `- ${when.ny} (Eastern)`);
  if (when.them) md.push(`- ${when.them} (invitee's time)`);
  md.push("");
  if (zoom) md.push(`**Location:** Zoom`, `${zoom}`, "");
  if (inv.timezone) md.push(`**Invitee Time Zone:** ${inv.timezone}`, "");
  if (canceled) md.push(`**Canceled by:** ${ev.cancellation?.canceler_type || "?"}`, `**Reason:** ${ev.cancellation?.reason || "none given"}`, "");
  if (qa.length) { md.push(`### Questions`, ""); for (const q of qa) md.push(`**${q.question}**`, "", q.answer, ""); }
  const links = [];
  if (inv.reschedule_url) links.push(`[Reschedule](${inv.reschedule_url})`);
  if (inv.cancel_url) links.push(`[Cancel](${inv.cancel_url})`);
  links.push(`[View in Calendly](https://calendly.com/app/scheduled_events/user/me)`);
  md.push(links.join(" · "));
  a.markdown = md.join("\n");

  // WhatsApp (CallMeBot renders *bold*). Short: name, time, instrument-type answers, link.
  const wa = [`*${kind}: ${ev.name}*`, `${inv.name || "?"} <${inv.email || "?"}>`, `${when.you}`, `(${when.ny})`];
  for (const q of qa.slice(0, 4)) wa.push(`*${q.question.replace(/\?+$/, "")}:* ${q.answer.slice(0, 120)}`);
  if (canceled) wa.push(`Reason: ${ev.cancellation?.reason || "none given"}`);
  if (zoom) wa.push(zoom);
  a.text = wa.join("\n");
  a.subject = `${kind}: ${inv.name || "?"} - ${when.you} - ${ev.name}`;
  alerts.push(a);
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
  await t.sendMail({ from: `Calendly Alert <${GMAIL_USER}>`, to: ALERT_EMAIL_TO || GMAIL_USER, subject: a.subject, text: a.markdown });
  return "email: sent";
}
// Zero-credential email: open a GitHub issue. GitHub emails the repo owner the
// full body (issues are created by the Actions bot, so the owner is notified).
async function sendIssue(a) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return "issue: skipped (not on Actions)";
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ title: a.subject, body: a.markdown, assignees: [GITHUB_REPOSITORY.split("/")[0]], labels: [a.kind === "CANCELED" ? "canceled" : "booking"] }),
  });
  return `issue: ${r.status}${r.ok ? " " + (await r.json()).html_url : " " + (await r.text()).slice(0, 100)}`;
}
// Discord: one embed per alert. The Discord mobile app pushes it to the phone.
async function sendDiscord(a) {
  if (!DISCORD_WEBHOOK_URL) return "discord: skipped (no DISCORD_WEBHOOK_URL)";
  const canceled = a.kind === "CANCELED";
  const fields = [
    { name: "Invitee", value: `${a.inv.name || "?"}\n${a.inv.email || "?"}`, inline: true },
    { name: "When", value: `${a.when.you}\n${a.when.ny}`, inline: true },
  ];
  if (a.inv.timezone) fields.push({ name: "Invitee time zone", value: a.inv.timezone, inline: true });
  for (const q of a.qa.slice(0, 8)) fields.push({ name: q.question.slice(0, 256), value: q.answer.slice(0, 1024) });
  if (canceled) fields.push({ name: "Reason", value: `${a.cancellation?.reason || "none given"} (by ${a.cancellation?.canceler_type || "?"})` });
  const links = [a.zoom ? `[Zoom](${a.zoom})` : null, a.inv.reschedule_url ? `[Reschedule](${a.inv.reschedule_url})` : null].filter(Boolean).join(" · ");
  if (links) fields.push({ name: "Links", value: links });
  const r = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Calendly", content: `${canceled ? "❌" : "📅"} **${a.kind}: ${a.event}**`,
      embeds: [{ title: a.subject, color: canceled ? 0xed4245 : 0x57f287, fields, footer: { text: "calendly-alert" }, timestamp: new Date().toISOString() }],
    }),
  });
  return `discord: ${r.status}${r.ok ? "" : " " + (await r.text()).slice(0, 100)}`;
}
async function sendWhatsApp(a) {
  if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) return "whatsapp: skipped (no CALLMEBOT_* secrets)";
  const u = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(CALLMEBOT_PHONE)}&apikey=${encodeURIComponent(CALLMEBOT_APIKEY)}&text=${encodeURIComponent(a.text)}`;
  const r = await fetch(u);
  return `whatsapp: ${r.status} ${(await r.text()).slice(0, 80).replace(/\s+/g, " ")}`;
}

console.log(`${events.length} events checked, ${alerts.length} alert(s)${firstRun ? " (first run: baseline only)" : ""}`);
for (const a of alerts) {
  console.log("----\n" + a.markdown);
  if (DRY_RUN) { console.log("(dry run, not sent)"); continue; }
  console.log(await sendIssue(a).catch((e) => `issue: FAILED ${e.message}`));
  console.log(await sendDiscord(a).catch((e) => `discord: FAILED ${e.message}`));
  console.log(await sendEmail(a).catch((e) => `email: FAILED ${e.message}`));
  console.log(await sendWhatsApp(a).catch((e) => `whatsapp: FAILED ${e.message}`));
}
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
