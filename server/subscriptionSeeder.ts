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
    priceInCents: 2999, // $29.99/mo
    platformFeeBps: 800,
    stripePriceId: 'price_1TBN0rBXLHe4A1FGdPxUowLM',
    features: [
      'Product & service listings',
      'Basic analytics',
      'Customer messaging',
      'Standard discovery',
    ],
    alaCarteDiscountPercent: 0,
    sortOrder: 0,
  },
  {
    name: 'growth',
    displayName: 'Growth',
    description: 'For businesses ready to grow with real tools.',
    priceInCents: 5999, // $59.99/mo
    platformFeeBps: 800,
    stripePriceId: 'price_1TBN1CBXLHe4A1FGiGdGx0ZF',
    features: [
      'Everything in Starter',
      'Advanced analytics',
      '1 complimentary Unranked influencer per month',
      'Shoot credits (1 credit/month)',
    ],
    alaCarteDiscountPercent: 10,
    sortOrder: 1,
  },
  {
    name: 'pro',
    displayName: 'Pro',
    description: 'For established businesses that want maximum impact.',
    priceInCents: 9999, // $99.99/mo
    platformFeeBps: 800,
    stripePriceId: 'price_1TBN1TBXLHe4A1FGcJTK79L0',
    features: [
      'Everything in Growth',
      '1 Silver or 2 Bronze tier influencers per month',
      'Shoot credits (2 credits/month)',
      'Authority badge',
    ],
    alaCarteDiscountPercent: 20,
    sortOrder: 2,
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

  console.log("[Subscriptions] Tiers synced: Starter ($29.99), Growth ($59.99), Pro ($99.99)");
}
