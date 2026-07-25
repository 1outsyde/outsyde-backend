/**
 * Fix duplicate vendor_subscriptions rows.
 *
 * For each vendor that has more than one row, this script:
 *   1. Keeps the most recent active/trialing row as the canonical one.
 *   2. Cancels any additional Stripe subscriptions that are still live.
 *   3. Marks the extra DB rows as 'canceled'.
 *
 * Run dry-run first:
 *   npx tsx scripts/fix-duplicate-subscriptions.ts --dry-run
 *
 * Apply:
 *   npx tsx scripts/fix-duplicate-subscriptions.ts
 */

import { db } from "../server/db";
import { vendorSubscriptions } from "@shared/schema";
import { sql, eq } from "drizzle-orm";
import { getUncachableStripeClient } from "../server/stripe/stripeClient";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log(`[fix-duplicates] Running in ${DRY_RUN ? "DRY-RUN" : "APPLY"} mode\n`);

  // Find all vendorIds with more than one subscription row.
  const dupRows = await db.execute<{ vendor_id: string; count: string }>(
    sql`SELECT vendor_id, COUNT(*) AS count FROM vendor_subscriptions GROUP BY vendor_id HAVING COUNT(*) > 1`
  );

  const vendorIds = dupRows.rows.map((r) => r.vendor_id);
  if (vendorIds.length === 0) {
    console.log("[fix-duplicates] No vendors with duplicate subscriptions found. Nothing to do.");
    return;
  }

  console.log(`[fix-duplicates] Found ${vendorIds.length} vendor(s) with duplicate subscription rows.`);
  const stripe = await getUncachableStripeClient();

  for (const vendorId of vendorIds) {
    const rows = await db
      .select()
      .from(vendorSubscriptions)
      .where(eq(vendorSubscriptions.vendorId, vendorId))
      .orderBy(
        sql`CASE WHEN status IN ('active', 'trialing') THEN 0 ELSE 1 END`,
        sql`created_at DESC`
      );

    const [canonical, ...extras] = rows;

    console.log(`\nVendor ${vendorId}:`);
    console.log(`  Canonical → id=${canonical.id} status=${canonical.status} stripeSubId=${canonical.stripeSubscriptionId ?? "none"}`);

    for (const extra of extras) {
      console.log(`  Extra     → id=${extra.id} status=${extra.status} stripeSubId=${extra.stripeSubscriptionId ?? "none"}`);

      // Cancel on Stripe if still live and different from canonical's subscription.
      if (
        extra.stripeSubscriptionId &&
        extra.stripeSubscriptionId !== canonical.stripeSubscriptionId
      ) {
        try {
          const stripeSub = await stripe.subscriptions.retrieve(extra.stripeSubscriptionId);
          const stripeStatus = (stripeSub as unknown as { status: string }).status;

          if (!["canceled", "incomplete_expired"].includes(stripeStatus)) {
            if (DRY_RUN) {
              console.log(`  [dry-run] Would cancel Stripe subscription ${extra.stripeSubscriptionId} (status=${stripeStatus})`);
            } else {
              await stripe.subscriptions.cancel(extra.stripeSubscriptionId);
              console.log(`  Cancelled Stripe subscription ${extra.stripeSubscriptionId}`);
            }
          } else {
            console.log(`  Stripe subscription ${extra.stripeSubscriptionId} already ${stripeStatus} — skipping Stripe cancel`);
          }
        } catch (err) {
          console.error(`  Failed to check/cancel Stripe subscription ${extra.stripeSubscriptionId}:`, err);
        }
      }

      // Mark extra DB row as canceled.
      if (DRY_RUN) {
        console.log(`  [dry-run] Would mark DB row ${extra.id} as canceled`);
      } else {
        await db
          .update(vendorSubscriptions)
          .set({ status: "canceled", updatedAt: new Date() })
          .where(eq(vendorSubscriptions.id, extra.id));
        console.log(`  Marked DB row ${extra.id} as canceled`);
      }
    }
  }

  console.log("\n[fix-duplicates] Done.");
}

main().catch((err) => {
  console.error("[fix-duplicates] Fatal error:", err);
  process.exit(1);
});
