import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import type { AuthenticatedRequest } from "../auth";

const router = Router();

interface SubscriptionRow {
  id: string;
  name: string;
  display_name: string;
  price_in_cents: number;
  max_staff: number | null;
  features: string[] | null;
  benefit_type: string | null;
  benefit_name: string | null;
  description: string | null;
  is_unlimited: boolean | null;
  included_quantity: number | null;
}

router.get("/features", async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const businessId = authReq.user?.businessId;

  if (!businessId) {
    return res.status(403).json({ error: "business_role_required" });
  }

  try {
    const result = await db.execute<SubscriptionRow>(sql`
      SELECT
        st.id, st.name, st.display_name, st.price_in_cents, st.max_staff, st.features,
        tb.benefit_type, tb.benefit_name, tb.description, tb.is_unlimited, tb.included_quantity
      FROM vendor_subscriptions vs
      JOIN subscription_tiers st ON st.id = vs.tier_id
      LEFT JOIN tier_benefits tb ON tb.tier_id = st.id
      WHERE vs.business_id = ${businessId} AND vs.status = 'active'
    `);

    const rows = result.rows;

    if (rows.length === 0) {
      return res.status(404).json({ error: "no_active_subscription" });
    }

    const first = rows[0];

    const tier = {
      name: first.name,
      display_name: first.display_name,
      price_in_cents: first.price_in_cents,
      max_staff: first.max_staff,
    };

    const features: string[] = Array.isArray(first.features) ? first.features : [];

    const benefits = rows
      .filter((r) => r.benefit_type !== null)
      .map((r) => ({
        benefit_type: r.benefit_type as string,
        benefit_name: r.benefit_name as string,
        description: r.description,
        is_unlimited: r.is_unlimited,
        included_quantity: r.included_quantity,
      }));

    return res.json({ tier, features, benefits });
  } catch (error) {
    console.error("[vendorSubscription] /features error:", error);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

export default router;
