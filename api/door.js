// Door check-in API, protected by the DOOR_PIN environment variable.
import crypto from "node:crypto";
import { sql, normalizeCode, issueTickets, emailPending } from "../lib/tickets.js";

function pinOk(pin) {
  const want = process.env.DOOR_PIN || "";
  const a = Buffer.from(String(pin || ""));
  const b = Buffer.from(want);
  return want && a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("POST only");
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  if (!pinOk(body.pin)) return res.status(401).json({ error: "Wrong PIN" });
  const db = sql();
  const code = normalizeCode(body.code);

  switch (body.action) {
    case "stats": {
      const [s] = await db`SELECT
        count(*) FILTER (WHERE status = 'valid')::int AS sold,
        count(*) FILTER (WHERE status = 'valid' AND checked_in_at IS NOT NULL)::int AS checked_in,
        count(*) FILTER (WHERE status = 'refunded')::int AS refunded
        FROM tickets`;
      return res.json(s);
    }
    case "search": {
      const q = String(body.q || "").trim();
      if (q.length < 2) return res.json({ tickets: [] });
      const like = `%${q}%`;
      const tickets = await db`SELECT * FROM tickets
        WHERE code = ${normalizeCode(q)} OR code ILIKE ${like} OR buyer_name ILIKE ${like} OR buyer_email ILIKE ${like}
        ORDER BY buyer_name, payment_id, seat_no LIMIT 50`;
      return res.json({ tickets });
    }
    case "checkin": {
      const [t] = await db`SELECT * FROM tickets WHERE code = ${code}`;
      if (!t) return res.status(404).json({ error: "No ticket with that number" });
      if (t.status !== "valid") return res.status(409).json({ error: "This ticket was refunded", ticket: t });
      if (t.checked_in_at) return res.status(409).json({ error: "Already checked in", ticket: t });
      const [done] = await db`UPDATE tickets SET checked_in_at = now() WHERE code = ${code} AND checked_in_at IS NULL RETURNING *`;
      if (!done) return res.status(409).json({ error: "Already checked in", ticket: t });
      return res.json({ ticket: done });
    }
    case "undo": {
      const [t] = await db`UPDATE tickets SET checked_in_at = NULL WHERE code = ${code} RETURNING *`;
      return t ? res.json({ ticket: t }) : res.status(404).json({ error: "No ticket with that number" });
    }
    case "resend": {
      const [t] = await db`SELECT payment_id FROM tickets WHERE code = ${code}`;
      if (!t) return res.status(404).json({ error: "No ticket with that number" });
      return res.json({ emailed: await emailPending(t.payment_id, { force: true }) });
    }
    case "issue": {
      // Backfill for a purchase made before the webhook was connected.
      return res.json(await issueTickets(String(body.paymentId || "")));
    }
    default:
      return res.status(400).json({ error: "Unknown action" });
  }
}
