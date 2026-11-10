# Tracking — Berlin Encore!

One table, `events` (migration 017): who (`chat_id`), what (`name`), on which item (`item_id`), to what (`target`), when (`at`, UTC).
No third-party tool, no cookies, nothing sent outside our D1. Visible in Réglages → Admin (owner only), excluding the owner's own events.

Rule: **one event = one user intent**. We log on the server whenever the action goes through the API (reliable);
the client only logs what the server can't see (outbound clicks, calendar, invite sharing) via `/app/api/track` (allowlist `TRACKABLE`).

## Events

Name | Source | item_id | target
---|---|---|---
`open` | server, `state` (max 1 per 30 min per person) | — | `web` / `telegram`
`signup` | server, first valid code of a new account | — | —
`login` | server, each new session | — | —
`want` / `unwant` | server, op `i` / `ui` | item | —
`book` / `book_cancel` | server, op `bd` / `bx` | item | `with:N` (booked for N friends)
`seen` | server, op `v` | item | —
`rate` | server, op `r` | item | rating
`review_open` / `review` | server, op `w` / `/review` | item | —
`not_for_me` | server, op `x` | item | —
`undo` | server, op `u` | item | —
`share` | server, `/share` (💌 send to…) | item | `to:N[:note]`
`friend_add` / `friend_accept` / `friend_ignore` / `friend_remove` | server, `/friend` | — | —
`venue_toggle` / `venue_kind_toggle` | server, op `s` / `sk` | — | venue / `kind:on|off`
`lang` | server, op `l` | — | language
`feedback` / `photo` | server | — | —
`link_out` | client, click on an external link (tickets, critics, Letterboxd…) | item if the link is on a card | domain (`schaubuehne.de`, `letterboxd.com`…)
`calendar_add` | client, 📅 Google / iPhone | item | `google` / `ics`
`invite_share` / `invite_copy` | client, invite link | — | —

Reaction state (how many 🙋 / 🎟 / ✅ right now) still comes from `reactions`: `events` measures **flows** (how many times, over 7 / 30 days), `reactions` measures the **stock**.

## Adding an event

1. Name it as a verb/state in snake_case, from the user's point of view (`calendar_add`, not `click_cal_btn`).
2. Server side if the action goes through the API: `track(env, ctx, chat, "name", item, target)`.
   Otherwise add it to `TRACKABLE` (app.ts) and call `trackEv("name", item, target)` on the client.
3. Add its label in `EV` (adminTab, app.html) and a row in this table.
