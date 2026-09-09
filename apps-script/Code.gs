/**
 * Calendly booking alerts, Google Apps Script edition.
 * Runs every 5 minutes on Google's servers under YOUR Google account.
 * New booking / cancellation -> Discord webhook + email from your own Gmail
 * with a clean subject ("New booking: Name, Fri, Sep 11, 8:00 PM").
 *
 * One-time setup (about 2 minutes):
 *   1. script.google.com  ->  New project  ->  paste this file  ->  save.
 *   2. Project Settings (gear)  ->  Script Properties  ->  add:
 *        CALENDLY_TOKEN      = your Calendly personal access token
 *        CALENDLY_USER_URI   = https://api.calendly.com/users/<uuid>
 *        DISCORD_WEBHOOK_URL = the Discord webhook URL
 *        ALERT_EMAIL_TO      = trombonetimo@gmail.com   (optional, defaults to you)
 *   3. Pick the function "setup" in the toolbar, press Run, accept the
 *      permission prompt once. That baselines existing bookings and creates
 *      the 5-minute trigger. Done.
 */

var TZ = "Asia/Tokyo";

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  PropertiesService.getScriptProperties().deleteProperty("STATE");
  poll(); // first run only baselines, sends nothing
  ScriptApp.newTrigger("poll").timeBased().everyMinutes(5).create();
  Logger.log("Trigger created. Alerts start with the next new booking.");
}

function poll() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("CALENDLY_TOKEN");
  var user = props.getProperty("CALENDLY_USER_URI");
  if (!token || !user) throw new Error("Set CALENDLY_TOKEN and CALENDLY_USER_URI in Script Properties");

  var state = JSON.parse(props.getProperty("STATE") || '{"events":{},"initialized":false}');
  var firstRun = !state.initialized;
  var since = new Date(Date.now() - 2 * 24 * 3600e3).toISOString();
  var url = "https://api.calendly.com/scheduled_events?user=" + encodeURIComponent(user) +
            "&min_start_time=" + since + "&sort=start_time:desc&count=100";
  var events = [];
  while (url) {
    var page = cal(url, token);
    events = events.concat(page.collection);
    url = page.pagination && page.pagination.next_page ? page.pagination.next_page : null;
  }

  var alerts = [];
  events.forEach(function (ev) {
    var uuid = ev.uri.split("/").pop();
    var prev = state.events[uuid];
    if (prev && prev.status === ev.status) return;
    state.events[uuid] = { status: ev.status, start: ev.start_time };
    if (firstRun) return;
    var inv = (cal(ev.uri + "/invitees", token).collection || [])[0] || {};
    alerts.push(build(ev, inv));
  });

  var cutoff = Date.now() - 30 * 24 * 3600e3;
  Object.keys(state.events).forEach(function (k) { if (new Date(state.events[k].start).getTime() < cutoff) delete state.events[k]; });
  state.initialized = true;
  state.last_run = new Date().toISOString();
  props.setProperty("STATE", JSON.stringify(state));

  alerts.forEach(function (a) {
    try { sendDiscord(a); } catch (e) { Logger.log("discord failed: " + e); }
    try { sendEmail(a); } catch (e) { Logger.log("email failed: " + e); }
  });
  Logger.log(events.length + " events checked, " + alerts.length + " alert(s)" + (firstRun ? " (baseline)" : ""));
}

function cal(url, token) {
  var r = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });
  if (r.getResponseCode() >= 300) throw new Error("Calendly " + r.getResponseCode() + " " + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText());
}

function fmt(iso, tz, short) {
  return Utilities.formatDate(new Date(iso), tz, short ? "EEE, MMM d, h:mm a" : "EEE, MMM d, h:mm a z");
}

function build(ev, inv) {
  var canceled = ev.status === "canceled";
  var kind = canceled ? "Canceled" : "New booking";
  var qa = (inv.questions_and_answers || []).filter(function (q) { return (q.answer || "").trim(); });
  var you = fmt(ev.start_time, TZ), ny = fmt(ev.start_time, "America/New_York");
  var them = inv.timezone ? fmt(ev.start_time, inv.timezone) : null;
  var zoom = ev.location && ev.location.join_url ? ev.location.join_url : null;

  var h = [];
  h.push("<h2>" + (canceled ? "Event canceled" : "A new event has been scheduled") + "</h2>");
  h.push("<p><b>Event Type:</b> " + esc(ev.name) + "</p>");
  h.push("<p><b>Invitee:</b> " + esc(inv.name || "?") + "</p>");
  h.push("<p><b>Invitee Email:</b> " + esc(inv.email || "?") + "</p>");
  if (inv.text_reminder_number) h.push("<p><b>Phone:</b> " + esc(inv.text_reminder_number) + "</p>");
  h.push("<p><b>Event Date/Time:</b><br>&nbsp;&nbsp;" + you + " (your time)<br>&nbsp;&nbsp;" + ny + " (Eastern)" + (them ? "<br>&nbsp;&nbsp;" + them + " (invitee's time)" : "") + "</p>");
  if (zoom) h.push("<p><b>Location:</b> Zoom<br><a href=\"" + zoom + "\">" + zoom + "</a></p>");
  if (inv.timezone) h.push("<p><b>Invitee Time Zone:</b> " + esc(inv.timezone) + "</p>");
  if (canceled) h.push("<p><b>Canceled by:</b> " + esc((ev.cancellation || {}).canceler_type || "?") + "<br><b>Reason:</b> " + esc((ev.cancellation || {}).reason || "none given") + "</p>");
  if (qa.length) { h.push("<h3>Questions</h3>"); qa.forEach(function (q) { h.push("<p><b>" + esc(q.question) + "</b><br>" + esc(q.answer).replace(/\n/g, "<br>") + "</p>"); }); }
  var links = [];
  if (inv.reschedule_url) links.push("<a href=\"" + inv.reschedule_url + "\">Reschedule</a>");
  if (inv.cancel_url) links.push("<a href=\"" + inv.cancel_url + "\">Cancel</a>");
  links.push("<a href=\"https://calendly.com/app/scheduled_events/user/me\">View in Calendly</a>");
  h.push("<p>" + links.join(" &middot; ") + "</p>");

  return {
    kind: kind, canceled: canceled, event: ev.name, inv: inv, you: you, ny: ny, zoom: zoom, qa: qa, cancellation: ev.cancellation,
    subject: kind + ": " + (inv.name || "?") + ", " + fmt(ev.start_time, TZ, true),
    html: "<div style=\"max-width:600px;margin:0 auto;padding:20px;font:14px/1.5 -apple-system,Helvetica,Arial;color:#222\">" + h.join("") + "</div>",
  };
}

function sendEmail(a) {
  var to = PropertiesService.getScriptProperties().getProperty("ALERT_EMAIL_TO") || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: to, subject: a.subject, htmlBody: a.html, name: "Calendly" });
}

function sendDiscord(a) {
  var hook = PropertiesService.getScriptProperties().getProperty("DISCORD_WEBHOOK_URL");
  if (!hook) return;
  var fields = [
    { name: "Invitee", value: (a.inv.name || "?") + "\n" + (a.inv.email || "?"), inline: true },
    { name: "When", value: a.you + "\n" + a.ny, inline: true },
  ];
  if (a.inv.timezone) fields.push({ name: "Invitee time zone", value: a.inv.timezone, inline: true });
  a.qa.slice(0, 8).forEach(function (q) { fields.push({ name: q.question.slice(0, 256), value: q.answer.slice(0, 1024) }); });
  if (a.canceled) fields.push({ name: "Reason", value: ((a.cancellation || {}).reason || "none given") + " (by " + ((a.cancellation || {}).canceler_type || "?") + ")" });
  var links = [];
  if (a.zoom) links.push("[Zoom](" + a.zoom + ")");
  if (a.inv.reschedule_url) links.push("[Reschedule](" + a.inv.reschedule_url + ")");
  if (links.length) fields.push({ name: "Links", value: links.join(" · ") });
  UrlFetchApp.fetch(hook, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify({
      username: "Calendly",
      content: (a.canceled ? "❌" : "📅") + " **" + a.kind.toUpperCase() + ": " + a.event + "**",
      embeds: [{ title: a.subject, color: a.canceled ? 0xed4245 : 0x57f287, fields: fields, footer: { text: "calendly-alert (Apps Script)" }, timestamp: new Date().toISOString() }],
    }),
  });
}

function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
