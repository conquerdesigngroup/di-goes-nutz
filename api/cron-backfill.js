// Daily safety net: issues tickets for any ticket sale from the last few days that the webhook missed.
import { backfill } from "../lib/tickets.js";

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("unauthorized");
  }
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const done = await backfill(since);
  const emailed = done.filter((r) => r.emailed);
  console.log("cron backfill", JSON.stringify({ since, checked: done.length, emailed }));
  return res.json({ orders: emailed.length });
}
