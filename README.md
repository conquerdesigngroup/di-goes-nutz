# DI Goes Nutz

One-page promo site for the Dancing Images holiday Nutcracker show.

- `/` centered layout (default)
- `/original` original left/right layout

Show details (date, venue, ticket link) live in the `SHOW` config near the top of the script in `index.html`.

## Ticket emails

When someone buys tickets through the Square link, Square calls `/api/square-webhook`. The function
creates one ticket number per seat (stored in the Neon `di-goes-nutz-tickets` database) and emails them
to the buyer from `tickets@didc.app` via Resend. Refunds mark the tickets refunded. Only Square line
items whose name matches `TICKET_ITEM_MATCH` (default `nut`) count as show tickets.

`/door` is the check-in page: enter the door PIN, then look up a ticket number or buyer name.

Environment variables (set in Vercel, never in the repo): `DATABASE_URL`, `RESEND_API_KEY`, `DOOR_PIN`,
`SQUARE_ACCESS_TOKEN`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, and optionally `SQUARE_WEBHOOK_URL`,
`TICKET_FROM`, `TICKET_REPLY_TO`, `TICKET_ITEM_MATCH`.
