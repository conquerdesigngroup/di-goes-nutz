// Square webhook: issues and emails numbered tickets when a show ticket payment completes,
// and marks tickets refunded when the payment is refunded.
import { validSquareSignature, issueTickets, applyRefund } from "../lib/tickets.js";

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("POST only");
  const raw = await readRaw(req);
  if (!validSquareSignature(raw, req.headers["x-square-hmacsha256-signature"])) {
    let type = "unknown";
    try { type = JSON.parse(raw).type; } catch {}
    console.warn("rejected webhook: bad signature", JSON.stringify({
      type,
      host: req.headers.host,
      hasSignature: Boolean(req.headers["x-square-hmacsha256-signature"]),
      hasKey: Boolean(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY),
    }));
    return res.status(401).send("bad signature");
  }
  const event = JSON.parse(raw);
  const obj = event.data?.object || {};
  try {
    let result = { ignored: event.type };
    if ((event.type === "payment.created" || event.type === "payment.updated") && obj.payment?.status === "COMPLETED") {
      result = await issueTickets(obj.payment.id);
    } else if ((event.type === "refund.created" || event.type === "refund.updated") && obj.refund?.status === "COMPLETED") {
      result = await applyRefund(obj.refund.payment_id);
    }
    console.log(event.type, event.event_id, JSON.stringify(result));
    return res.status(200).json(result);
  } catch (err) {
    // A non-2xx makes Square retry the delivery later.
    console.error(event.type, event.event_id, err);
    return res.status(500).send("error");
  }
}

export const config = { api: { bodyParser: false } };
