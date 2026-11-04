/**
 * Quote expiry (Quotes step 2). Every few minutes, sent quotes past their expiry are marked expired and the chat
 * gets an "expired" card. One UPDATE ... RETURNING claims each quote, so a quote is announced once even with two
 * servers or an overlapping run. Reads already treat a quote past its expiry as expired (quoteRules.effectiveStatus).
 */
import { and, eq, lte } from "drizzle-orm";
import { db } from "../db";
import { quotes } from "@shared/schema";
import { postEvent } from "./quoteRoutes";

export async function expireDueQuotes(now = new Date()): Promise<number> {
  const due = await db.update(quotes)
    .set({ status: "expired", expiredAt: now, updatedAt: now })
    .where(and(eq(quotes.status, "sent"), lte(quotes.expiresAt, now)))
    .returning();
  for (const q of due) await postEvent(q, "expired", false);
  return due.length;
}

let timer: NodeJS.Timeout | null = null;
export function startQuoteExpiryJob(intervalMs = 5 * 60 * 1000): void {
  if (timer) return;
  const run = () => expireDueQuotes().catch((err) => console.error("[quotes] expiry job failed:", err));
  timer = setInterval(run, intervalMs);
  setTimeout(run, 30 * 1000);
}
