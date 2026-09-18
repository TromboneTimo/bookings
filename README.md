# calendly-alert

Polls a Calendly account every 5 minutes (GitHub Actions) and sends an email +
WhatsApp message for every new booking and every cancellation. Built because
Calendly's free plan has no webhooks and its host notifications only go to the
account's login email.

Secrets live in GitHub Actions secrets only. `state.json` is the memory of
which events have already been alerted on; the workflow commits it back.

WhatsApp uses CallMeBot (free, personal use): send "I allow callmebot to send
me messages" to their WhatsApp number, they reply with an API key.
Email uses Gmail SMTP with a Google App Password.

## Superseded 2026-09-18

Booking alerts now run inside the fb-funnel Vercel project, not here:

- Instant: the Calendly embed on /schedule posts to `/api/book`, which alerts Tim
  (Discord + a GitHub issue in this repo) the moment it has the invitee.
- Every 5 minutes: Supabase pg_cron calls `/api/book?poll=1` with a cron secret.
  That is the same diff logic as `poll.mjs`, with its state in the Supabase table
  `cc_calendly_alerts` instead of `state.json`.

Why: GitHub throttles scheduled workflows on free accounts, so this repo's
`*/5 * * * *` cron actually fired about 7 times a day instead of 288.

This repo is kept for two reasons only: it is still the GitHub-issue email
channel (issues opened here are what email Tim), and it is a manual backup:

    gh workflow run poll.yml -R TromboneTimo/bookings

