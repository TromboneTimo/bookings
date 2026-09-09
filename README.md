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
