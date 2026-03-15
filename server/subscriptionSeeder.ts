/**
 * Seed default subscription tiers for vendor onboarding.
 * Idempotent — only inserts if the table is empty.
 */

import { db } from "./db";
import { subscriptionTiers } from "@shared/schema";

export async function seedSubscriptionTiers(): Promise<void> {
  const existing = await db.select().from(subscriptionTiers);
  if (existing.length > 0) return;

  console.log("[Subscriptions] Seeding default subscription tiers...");

  await db.insert(subscriptionTiers).values([
    {
      name: 'access',
      displayName: 'Access',
      description: 'Get started with your online storefront. List products, accept bookings, and reach local customers.',
      priceInCents: 2000, // $20/month
      platformFeeBps: 800, // informational — actual fee logic is in fees.ts
      features: [
        'Online storefront',
        'Up to 25 product listings',
        'Booking calendar',
        'Customer messaging',
        'Basic analytics',
      ],
      alaCarteDiscountPercent: 0,
      sortOrder: 0,
    },
    {
      name: 'growth',
      displayName: 'Growth',
      description: 'Scale your business with advanced tools, unlimited listings, and priority placement in search.',
      priceInCents: 4000, // $40/month
      platformFeeBps: 800,
      features: [
        'Everything in Access',
        'Unlimited product listings',
        'Priority search placement',
        'Multi-staff management',
        'Advanced analytics',
        'Loyalty program integration',
      ],
      alaCarteDiscountPercent: 10,
      sortOrder: 1,
    },
    {
      name: 'pro',
      displayName: 'Pro',
      description: 'Full suite for established businesses. Sponsored posts, featured placement, and dedicated support.',
      priceInCents: 8900, // $89/month
      platformFeeBps: 800,
      features: [
        'Everything in Growth',
        'Sponsored post credits',
        'Featured storefront placement',
        'Shipment tracking',
        'Team payouts (Stripe Connect per staff)',
        'Priority customer support',
        'Custom branding',
      ],
      alaCarteDiscountPercent: 20,
      sortOrder: 2,
    },
  ]);

  console.log("[Subscriptions] 3 tiers seeded: Access ($20), Growth ($40), Pro ($89)");
}
