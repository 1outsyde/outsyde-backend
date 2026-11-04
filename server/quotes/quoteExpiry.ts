/**
 * Quote expiry (Quotes step 2). Every few minutes, sent quotes past their expiry are marked expired and the chat
 * gets an "expired" card. One UPDATE ... RETURNING claims each quote, so a quote is announced once even with two
 * servers or an overlapping run. Reads already treat a quote past its expiry as expired (quoteRules.effectiveStatus).
 */
import { and, eq, lte } from "drizzle-orm";
import { db } from "../db";
import { quotes } from "@shared/schema";
import { notPaying, postEvent } from "./quoteRoutes";
import { confirmMissedQuotePayments } from "./quotePaid";
import { resolveStaleFeeCharges } from "../payments/cancellationFees";

export async function expireDueQuotes(now = new Date()): Promise<number> {
  const due = await db.update(quotes)
    .set({ status: "expired", expiredAt: now, updatedAt: now })
    .where(and(eq(quotes.status, "sent"), lte(quotes.expiresAt, now), notPaying(now)))
    .returning();
  for (const q of due) await postEvent(q, "expired", false);
  return due.length;
}

let timer: NodeJS.Timeout | null = null;
export function startQuoteExpiryJob(intervalMs = 5 * 60 * 1000): void {
  if (timer) return;
  // Step 3: the same run is the backstop for quote payments whose Stripe confirmation was missed (R41, quotes only).
  const run = () => {
    expireDueQuotes().catch((err) => console.error("[quotes] expiry job failed:", err));
    confirmMissedQuotePayments().catch((err) => console.error("[quotes] payment backstop failed:", err));
    // R39: fee charges whose call failed are looked up at Stripe later (all bookings, not only quotes).
    resolveStaleFeeCharges().catch((err) => console.error("[cancel fee] later check failed:", err));
    // Step 4a: balance holds and retries, auto complete 2 h after the end, and releases for ended bookings.
    import("./quoteBalance").then((m) => m.runQuoteBalanceJob()).catch((err) => console.error("[quote balance] job failed:", err));
  };
  timer = setInterval(run, intervalMs);
  setTimeout(run, 30 * 1000);
}
