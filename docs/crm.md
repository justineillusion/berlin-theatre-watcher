# CRM — Berlin Encore!

What the app sends, when, and to whom. Update this file whenever a message is added, changed or removed.
Channels: **Telegram** (bot users), **push** (phones that enabled notifications; friends' activity only, as the in-app card promises), **inbox** (the Notifications
section at the top of Mes sorties, kept 7 days; counts in the Mes sorties tab badge).

## 1. Messages that exist today

### Friends (inbox + push, `lib.inbox` → `push.notifyPush`)
- `share` — a friend sends me a show (with their note).
- `booked` — a friend adds me to their booking.
- `friend_request` / `friend_ok` — connection asked / accepted.
- `proposal`, `prop_answer`, `prop_set`, `prop_cancel` — 🗳 proposals: new, someone answered, date set, cancelled.

### Ticket sales (`worker/src/sales.ts`, Worker cron every 15 min)
Calendar from `src/sales.py` (rules per venue, page announcements win), stored in `settings.sales`.
Venues covered: Schaubühne (1st of the month, 11:00), Berliner Ensemble (3rd of the previous month, 10:00),
Volksbühne (1st working day, hour not published).
- `sale` — **the day before, from 19:00 Berlin**: « 🎟 Demain 11h : ouverture des ventes Schaubühne pour janvier »,
  plus my ⭐ there. To everyone who follows the venue **or** has a ⭐ there. Telegram + inbox (no phone push: push is friends only).
- `sale_open` — at opening time (09:00 if unknown), within 3 h: « 🎟 C'est ouvert », only to people with a ⭐ there.
- `programme` — 14:00 on the first opening day of a month: « 🗓 Le programme de janvier est sorti », to all users.
  Telegram only (no phone push: push is friends only).
- Each send is keyed in `settings` (`sale_sent:…`, `programme_sent:…`): never twice.

### Shows (Python scan → `worker/src/scan.ts`, Telegram)
- `new` — new show at a followed venue.
- `star_dates` — a ⭐ show gets new dates (sent at once: book now).
- `new_dates` — new dates on a followed show (held until sales are open).
- `last_weeks` — last weeks of a show.
- Weekly digest (`digest.yml`, Sunday) and cinema of the week (`cinema.yml`).

### After an outing (Telegram, `bot.ts`)
- `review_prompts` — « C'était comment ? » the day after a booked date.

## 2. Yearly calendar (to plan)
- January: season restart, new programmes.
- February: Berlinale (ticket release, then festival films).
- May: Theatertreffen.
- Summer: open-air cinema, theatre summer break.
- September: theatre season opening (full programmes, subscriptions).
- November: Französische Filmwoche.
- December: holiday outing ideas, year recap (« tu as vu 14 spectacles »).

For each: send date, channel, text, audience.

## 3. Pressure rules (to decide, not built)
- At most 2 app-initiated notifications per person per week; friends' messages don't count.
- A friend's message goes before an app message.
- Several app messages on the same day are grouped into one.
- Nothing between 22:00 and 09:00 (the 19:00 sales reminder fits).

## 4. Metrics to watch monthly
- Share of friends opening the app at least once a week (`events.open`).
- Proposals sent.
- Outings booked.
