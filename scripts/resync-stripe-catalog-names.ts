/**
 * Re-sync Stripe Product names for live vendor services.
 *
 * Vendor catalog Products live on the vendor's Connect account, but the service
 * PATCH route used to call stripe.products.update without the account, so every
 * rename since go-live failed with resource_missing and was swallowed. Stripe
 * still shows whatever each service was called when it first went live.
 *
 * This script reads vendor_services (never writes to it) and pushes the DB name
 * onto the matching Stripe Product on the owning business's Connect account.
 * It is idempotent: products whose Stripe name already matches are skipped.
 *
 * Dry run (default), scoped to one business:
 *   npx tsx scripts/resync-stripe-catalog-names.ts --business=<businessId>
 *
 * Apply platform-wide, excluding one or more businesses:
 *   npx tsx scripts/resync-stripe-catalog-names.ts --apply --skip-business=<id>,<id>
 *
 * Requires DATABASE_URL and STRIPE_SECRET_KEY.
 */

import { and, eq, notInArray } from "drizzle-orm";
import { db } from "../server/db";
import { businesses, vendorServices } from "@shared/schema";
import { getUncachableStripeClient } from "../server/stripe/stripeClient";

const APPLY = process.argv.includes("--apply");

function readArg(flag: string): string | null {
  const match = process.argv.find((a) => a.startsWith(`${flag}=`));
  return match ? match.slice(flag.length + 1) : null;
}

const BUSINESS_ID = readArg("--business");
const SKIP_BUSINESS_IDS = (readArg("--skip-business") ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const LOG_PREFIX = "[resync-catalog-names]";

async function main() {
  console.log(
    `${LOG_PREFIX} Running in ${APPLY ? "APPLY" : "DRY-RUN"} mode` +
      (BUSINESS_ID ? ` for business ${BUSINESS_ID}` : " platform-wide"),
  );
  if (SKIP_BUSINESS_IDS.length > 0) {
    console.log(`${LOG_PREFIX} Excluding ${SKIP_BUSINESS_IDS.length} business(es): ${SKIP_BUSINESS_IDS.join(", ")}`);
  }

  const filters = [eq(vendorServices.status, "live")];
  if (BUSINESS_ID) {
    filters.push(eq(vendorServices.businessId, BUSINESS_ID));
  }
  if (SKIP_BUSINESS_IDS.length > 0) {
    filters.push(notInArray(vendorServices.businessId, SKIP_BUSINESS_IDS));
  }

  const rows = await db
    .select({
      serviceId: vendorServices.id,
      serviceName: vendorServices.name,
      price: vendorServices.price,
      stripeProductId: vendorServices.stripeProductId,
      businessId: businesses.id,
      businessName: businesses.name,
      stripeAccountId: businesses.stripeAccountId,
    })
    .from(vendorServices)
    .innerJoin(businesses, eq(vendorServices.businessId, businesses.id))
    .where(and(...filters))
    .orderBy(businesses.name, vendorServices.createdAt);

  if (rows.length === 0) {
    console.log(`${LOG_PREFIX} No live services found. Nothing to do.`);
    return;
  }

  console.log(`${LOG_PREFIX} Found ${rows.length} live service(s) to check.\n`);
  const stripe = await getUncachableStripeClient();

  let updated = 0;
  let alreadyInSync = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const label = `${row.businessName ?? row.businessId} / ${row.serviceId}`;

    // A live service can still be unprovisioned (never went live through Stripe)
    // or priced at zero, in which case there is no Product to rename.
    if (!row.stripeProductId) {
      console.log(`  SKIP  ${label} — no Stripe product`);
      skipped++;
      continue;
    }
    if (row.price <= 0) {
      console.log(`  SKIP  ${label} — price is ${row.price}`);
      skipped++;
      continue;
    }
    if (!row.stripeAccountId) {
      console.log(`  SKIP  ${label} — business has no Stripe Connect account`);
      skipped++;
      continue;
    }

    const productId = row.stripeProductId;
    const acct = { stripeAccount: row.stripeAccountId } as const;
    // Several names carry stray whitespace from vendor input; Stripe is the
    // customer-facing surface, so push the trimmed form.
    const desiredName = row.serviceName.trim();

    try {
      const product = await stripe.products.retrieve(productId, {}, acct);

      if (product.name === desiredName) {
        console.log(`  OK    ${label} — ${productId} already named "${desiredName}"`);
        alreadyInSync++;
        continue;
      }

      if (!APPLY) {
        console.log(
          `  DIFF  ${label} — ${productId} would change "${product.name}" -> "${desiredName}"`,
        );
        updated++;
        continue;
      }

      await stripe.products.update(productId, { name: desiredName }, acct);
      console.log(`  FIXED ${label} — ${productId} "${product.name}" -> "${desiredName}"`);
      updated++;
    } catch (err) {
      console.error(
        `  FAIL  ${label} — ${productId} on ${row.stripeAccountId}:`,
        err instanceof Error ? err.message : err,
      );
      failed++;
    }
  }

  console.log(
    `\n${LOG_PREFIX} Done. ${APPLY ? "updated" : "would update"}=${updated} ` +
      `alreadyInSync=${alreadyInSync} skipped=${skipped} failed=${failed}`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal error:`, err);
  process.exit(1);
});
