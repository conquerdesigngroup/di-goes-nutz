// Shared helpers for the ticket emails: Square lookups, the ticket table, and Resend.
import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

export const SHOW = {
  title: "DI Goes Nutz",
  subtitle: "A Dancing Images Nutcracker",
  dateLong: "Sunday, December 20, 2026",
  time: "5:00 PM",
  venue: "Marina Valley High School Theater",
  siteUrl: process.env.SITE_URL || "https://nutcracker.didancecenter.com",
};

const SQUARE_API = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2025-01-23";

export const sql = () => neon(process.env.DATABASE_URL);

// Square signs each webhook with HMAC-SHA256 over the subscription URL followed by the raw body.
export function validSquareSignature(rawBody, signature) {
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const url = process.env.SQUARE_WEBHOOK_URL || `${SHOW.siteUrl}/api/square-webhook`;
  if (!key || !signature) return false;
  const expected = crypto.createHmac("sha256", key).update(url + rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function square(path) {
  const res = await fetch(`${SQUARE_API}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      "Square-Version": SQUARE_VERSION,
    },
  });
  if (!res.ok) throw new Error(`Square ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// Only line items whose name matches count as show tickets, so other studio sales are ignored.
const ticketItem = () => new RegExp(process.env.TICKET_ITEM_MATCH || "nut", "i");

export function ticketCount(order) {
  return (order.line_items || [])
    .filter((li) => ticketItem().test(`${li.name || ""} ${li.variation_name || ""}`))
    .reduce((n, li) => n + (parseInt(li.quantity, 10) || 0), 0);
}

async function buyerFor(payment, order) {
  let name = "";
  let email = payment.buyer_email_address || "";
  const customerId = payment.customer_id || order.customer_id;
  if (customerId) {
    try {
      const { customer } = await square(`/customers/${customerId}`);
      name = [customer.given_name, customer.family_name].filter(Boolean).join(" ");
      email = email || customer.email_address || "";
    } catch (err) {
      console.warn("customer lookup failed", err.message);
    }
  }
  const recipient = (order.fulfillments || []).map(
    (f) => f.shipment_details?.recipient || f.pickup_details?.recipient || f.delivery_details?.recipient
  ).find(Boolean);
  const addr = payment.billing_address || payment.shipping_address;
  name = name || recipient?.display_name || [addr?.first_name, addr?.last_name].filter(Boolean).join(" ");
  email = email || recipient?.email_address || "";
  return { name, email };
}

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function newCode() {
  const bytes = crypto.randomBytes(6);
  return "NUTZ-" + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function normalizeCode(input) {
  const s = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^NUTZ/, "");
  return s ? `NUTZ-${s}` : "";
}

// Creates one ticket per seat for a completed payment (once), then emails any not yet sent.
export async function issueTickets(paymentId) {
  const db = sql();
  let rows = await db`SELECT * FROM tickets WHERE payment_id = ${paymentId} ORDER BY seat_no`;
  if (!rows.length) {
    const { payment } = await square(`/payments/${paymentId}`);
    if (payment.status !== "COMPLETED") return { skipped: `payment ${payment.status}` };
    if (!payment.order_id) return { skipped: "no order" };
    const { order } = await square(`/orders/${payment.order_id}`);
    const seats = ticketCount(order);
    if (!seats) return { skipped: "not a show ticket order" };
    const buyer = await buyerFor(payment, order);
    for (let seat = 1; seat <= seats; seat++) {
      // ON CONFLICT keeps duplicate webhook deliveries from making extra tickets.
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await db`
          INSERT INTO tickets (code, payment_id, order_id, seat_no, seats_in_order, buyer_name, buyer_email)
          VALUES (${newCode()}, ${paymentId}, ${payment.order_id}, ${seat}, ${seats}, ${buyer.name}, ${buyer.email})
          ON CONFLICT (payment_id, seat_no) DO NOTHING RETURNING code`;
        if (res.length || (await db`SELECT 1 FROM tickets WHERE payment_id = ${paymentId} AND seat_no = ${seat}`).length) break;
      }
    }
    rows = await db`SELECT * FROM tickets WHERE payment_id = ${paymentId} ORDER BY seat_no`;
  }
  return { tickets: rows.length, emailed: await emailPending(paymentId) };
}

// Claims unsent tickets by stamping emailed_at, so overlapping deliveries never send twice.
export async function emailPending(paymentId, { force = false } = {}) {
  const db = sql();
  // Wait until every seat row exists, so a buyer gets one email listing all of their tickets.
  const [{ have, want }] = await db`SELECT count(*)::int AS have, max(seats_in_order) AS want FROM tickets WHERE payment_id = ${paymentId}`;
  if (!have || have < want) return 0;
  const claimed = force
    ? await db`UPDATE tickets SET emailed_at = now() WHERE payment_id = ${paymentId} RETURNING *`
    : await db`UPDATE tickets SET emailed_at = now() WHERE payment_id = ${paymentId} AND emailed_at IS NULL RETURNING *`;
  if (!claimed.length) return 0;
  const all = await db`SELECT * FROM tickets WHERE payment_id = ${paymentId} AND status <> 'refunded' ORDER BY seat_no`;
  const to = all[0]?.buyer_email;
  if (!to) {
    console.warn(`no buyer email for payment ${paymentId}`);
    return 0;
  }
  try {
    await sendTicketEmail(to, all);
  } catch (err) {
    if (!force) await db`UPDATE tickets SET emailed_at = NULL WHERE code = ANY(${claimed.map((t) => t.code)})`;
    throw err;
  }
  return all.length;
}

export async function applyRefund(paymentId) {
  const db = sql();
  const { payment } = await square(`/payments/${paymentId}`);
  const paid = payment.total_money?.amount || 0;
  const refunded = payment.refunded_money?.amount || 0;
  if (!refunded) return { refunded: 0 };
  if (refunded >= paid) {
    const res = await db`UPDATE tickets SET status = 'refunded', note = 'Fully refunded' WHERE payment_id = ${paymentId} RETURNING code`;
    return { refunded: res.length };
  }
  const note = `Partial refund of $${(refunded / 100).toFixed(2)} of $${(paid / 100).toFixed(2)}`;
  await db`UPDATE tickets SET note = ${note} WHERE payment_id = ${paymentId}`;
  return { partial: note };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function ticketEmailHtml(tickets) {
  const first = (tickets[0]?.buyer_name || "").split(" ")[0];
  const font = "'Helvetica Neue', Helvetica, Arial, sans-serif";
  const cards = tickets.map((t) => `
    <tr><td style="padding-top:16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:2px dashed #f2c14e;border-radius:14px;" bgcolor="#fff3df">
        <tr>
          <td style="padding:18px 20px;font-family:${font};">
            <p style="margin:0;font-size:12px;line-height:16px;color:#a50f22;letter-spacing:2px;font-weight:bold;">ADMIT ONE &middot; TICKET ${t.seat_no} OF ${t.seats_in_order}</p>
            <p style="margin:6px 0 0 0;font-family:'Courier New', Courier, monospace;font-size:30px;line-height:36px;color:#1a0f0a;font-weight:bold;letter-spacing:2px;">${esc(t.code)}</p>
            <p style="margin:6px 0 0 0;font-size:13px;line-height:18px;color:#145a34;">${esc(SHOW.dateLong)} &middot; ${esc(SHOW.time)} &middot; ${esc(SHOW.venue)}</p>
          </td>
        </tr>
      </table>
    </td></tr>`).join("");
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>Your DI Goes Nutz tickets</title></head>
<body style="margin:0;padding:0;background-color:#0b3320;" bgcolor="#0b3320">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0b3320"><tr><td align="center" style="padding:24px 12px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
    <tr><td align="center" style="padding:8px 0 4px 0;font-family:${font};">
      <p style="margin:0;font-size:13px;line-height:18px;color:#f2c14e;letter-spacing:3px;font-weight:bold;">DANCING IMAGES DANCE CENTER PRESENTS</p>
      <p style="margin:8px 0 0 0;font-family:Georgia, 'Times New Roman', serif;font-size:40px;line-height:44px;color:#fff3df;font-weight:bold;">DI Goes Nutz</p>
      <p style="margin:4px 0 0 0;font-size:15px;line-height:20px;color:#b9d3c1;">${esc(SHOW.subtitle)}</p>
    </td></tr>
    <tr><td style="padding-top:20px;font-family:${font};">
      <p style="margin:0;font-size:16px;line-height:24px;color:#fff3df;">${first ? `Hi ${esc(first)},` : "Hi there,"}</p>
      <p style="margin:10px 0 0 0;font-size:16px;line-height:24px;color:#fff3df;">Thanks for your order! Your ${tickets.length === 1 ? "ticket is" : `${tickets.length} tickets are`} below. Show this email at the door (on your phone is fine), and we'll check you in by ticket number.</p>
    </td></tr>
    ${cards}
    <tr><td style="padding-top:22px;font-family:${font};">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#145a34" style="border-radius:12px;"><tr><td style="padding:16px 20px;font-family:${font};">
        <p style="margin:0;font-size:14px;line-height:21px;color:#fff3df;"><strong style="color:#f2c14e;">When:</strong> ${esc(SHOW.dateLong)}, ${esc(SHOW.time)} (one show only)</p>
        <p style="margin:4px 0 0 0;font-size:14px;line-height:21px;color:#fff3df;"><strong style="color:#f2c14e;">Where:</strong> ${esc(SHOW.venue)}</p>
        <p style="margin:4px 0 0 0;font-size:14px;line-height:21px;color:#fff3df;"><strong style="color:#f2c14e;">Directed by:</strong> Carlos Renteria</p>
      </td></tr></table>
    </td></tr>
    <tr><td align="center" style="padding-top:22px;font-family:${font};">
      <p style="margin:0;font-size:13px;line-height:19px;color:#b9d3c1;">Each ticket number admits one guest and can be used once.<br>Show details: <a href="${SHOW.siteUrl}" style="color:#f2c14e;">${SHOW.siteUrl.replace(/^https?:\/\//, "")}</a></p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

export function ticketEmailText(tickets) {
  return [
    "DI Goes Nutz - your tickets",
    "",
    ...tickets.map((t) => `Ticket ${t.seat_no} of ${t.seats_in_order}: ${t.code}`),
    "",
    `${SHOW.dateLong}, ${SHOW.time}`,
    SHOW.venue,
    "",
    "Show this email at the door. Each ticket number admits one guest and can be used once.",
    SHOW.siteUrl,
  ].join("\n");
}

export async function sendTicketEmail(to, tickets) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.TICKET_FROM || "DI Goes Nutz Tickets <tickets@didc.app>",
      to: [to],
      reply_to: process.env.TICKET_REPLY_TO || undefined,
      subject: tickets.length === 1 ? "Your DI Goes Nutz ticket 🎟️" : `Your ${tickets.length} DI Goes Nutz tickets 🎟️`,
      html: ticketEmailHtml(tickets),
      text: ticketEmailText(tickets),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status} ${await res.text()}`);
  return res.json();
}
