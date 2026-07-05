/**
 * Seed subscription tiers for vendor onboarding.
 * Updates existing tiers if names match, inserts if missing.
 */

import { db } from "./db";
import { subscriptionTiers } from "@shared/schema";
import { eq } from "drizzle-orm";

const TIERS = [
  {
    name: 'starter',
    displayName: 'Starter',
    description: 'Perfect for new businesses ready to start selling.',
    priceInCents: 2900, // $29/mo
    platformFeeBps: 800,
    stripePriceId: 'price_1TNP3CBXLHe4A1FGCux43w00',
    features: [
      'Product & service listings',
      'Basic analytics',
      'Customer messaging',
      'Standard discovery',
    ],
    alaCarteDiscountPercent: 0,
    sortOrder: 0,
    maxStaff: 3,
  },
  {
    name: 'growth',
    displayName: 'Growth',
    description: 'For businesses ready to grow with real tools.',
    priceInCents: 5900, // $59/mo
    platformFeeBps: 800,
    stripePriceId: 'price_1TNP4DBXLHe4A1FGIga6ZQ0k',
    features: [
      'Everything in Starter',
      'Advanced analytics',
      '1 complimentary Unranked influencer per month',
      'Shoot credits (1 credit/month)',
    ],
    alaCarteDiscountPercent: 10,
    sortOrder: 1,
    maxStaff: 8,
  },
  {
    name: 'pro',
    displayName: 'Pro',
    description: 'For established businesses that want maximum impact.',
    priceInCents: 9900, // $99/mo
    platformFeeBps: 800,
    stripePriceId: 'price_1TNP4VBXLHe4A1FGREAhrzSU',
    features: [
      'Everything in Growth',
      '1 Silver or 2 Bronze tier influencers per month',
      'Shoot credits (2 credits/month)',
      'Authority badge',
    ],
    alaCarteDiscountPercent: 20,
    sortOrder: 2,
    maxStaff: null as number | null, // uncapped — no staff seat limit
  },
];

export async function seedSubscriptionTiers(): Promise<void> {
  for (const tier of TIERS) {
    const [existing] = await db.select()
      .from(subscriptionTiers)
      .where(eq(subscriptionTiers.name, tier.name));

    if (existing) {
      // Update existing tier to match current config
      await db.update(subscriptionTiers)
        .set({
          displayName: tier.displayName,
          description: tier.description,
          priceInCents: tier.priceInCents,
          platformFeeBps: tier.platformFeeBps,
          stripePriceId: tier.stripePriceId,
          features: tier.features,
          alaCarteDiscountPercent: tier.alaCarteDiscountPercent,
          sortOrder: tier.sortOrder,
          maxStaff: tier.maxStaff,
        })
        .where(eq(subscriptionTiers.id, existing.id));
    } else {
      await db.insert(subscriptionTiers).values(tier);
    }
  }

  // Remove legacy tiers that are no longer in the config
  const validNames = TIERS.map(t => t.name);
  const allTiers = await db.select().from(subscriptionTiers);
  for (const tier of allTiers) {
    if (!validNames.includes(tier.name)) {
      await db.delete(subscriptionTiers).where(eq(subscriptionTiers.id, tier.id));
      console.log(`[Subscriptions] Removed legacy tier: ${tier.name}`);
    }
  }

  console.log("[Subscriptions] Tiers synced: Starter ($29), Growth ($59), Pro ($99)");
}
