import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import type { AuthenticatedRequest } from "../auth";

const router = Router();

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ─── GET /daily ─────────────────────────────────────────────────────────────

interface OrderDayRow {
  day: string;
  order_count: number;
  revenue_cents: number;
}

interface BookingDayRow {
  day: string;
  booking_count: number;
}

router.get("/daily", async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const businessId = authReq.user?.businessId;
  if (!businessId) return res.status(403).json({ error: "business_role_required" });

  try {
    const [ordersResult, bookingsResult] = await Promise.all([
      db.execute<OrderDayRow>(sql`
        SELECT
          DATE(created_at)::text AS day,
          COUNT(*)::int AS order_count,
          COALESCE(SUM(total_amount), 0)::int AS revenue_cents
        FROM orders
        WHERE business_id = ${businessId}
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
      `),
      db.execute<BookingDayRow>(sql`
        SELECT
          DATE(created_at)::text AS day,
          COUNT(*)::int AS booking_count
        FROM appointments
        WHERE business_id = ${businessId}
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
      `),
    ]);

    const ordersByDay = new Map<string, { order_count: number; revenue_cents: number }>();
    for (const row of ordersResult.rows) {
      ordersByDay.set(row.day, { order_count: row.order_count, revenue_cents: row.revenue_cents });
    }

    const bookingsByDay = new Map<string, number>();
    for (const row of bookingsResult.rows) {
      bookingsByDay.set(row.day, row.booking_count);
    }

    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const label = DAY_LABELS[d.getDay()];
      const orderData = ordersByDay.get(dateStr);
      days.push({
        date: dateStr,
        label,
        revenue_cents: orderData?.revenue_cents ?? 0,
        order_count: orderData?.order_count ?? 0,
        booking_count: bookingsByDay.get(dateStr) ?? 0,
      });
    }

    return res.json({ days });
  } catch (error) {
    console.error("[vendorAnalytics] /daily error:", error);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

// ─── GET /audience ───────────────────────────────────────────────────────────

interface CountRow {
  total: string;
}

interface ConsumerProfileRow {
  gender: string | null;
  date_of_birth: string | null;
  shopping_frequency: string | null;
  selected_industries: string[] | null;
}

interface LocationRow {
  city: string;
  state: string | null;
  zip_code: string | null;
  customer_count: number;
}

function toSnake(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "_");
}

function ageBucket(dateOfBirth: string | null): string {
  if (!dateOfBirth) return "unknown";
  const age = new Date().getFullYear() - new Date(dateOfBirth).getFullYear();
  if (age < 25) return "18-24";
  if (age < 35) return "25-34";
  if (age < 45) return "35-44";
  return "45+";
}

router.get("/audience", async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const businessId = authReq.user?.businessId;
  if (!businessId) return res.status(403).json({ error: "business_role_required" });

  const emptyResponse = {
    total_customers: 0,
    gender: { male: 0, female: 0, non_binary: 0, prefer_not_to_say: 0, unknown: 0 },
    age_ranges: { "18-24": 0, "25-34": 0, "35-44": 0, "45+": 0, unknown: 0 },
    shopping_frequency: { rarely: 0, monthly: 0, weekly: 0, multiple_times_a_week: 0 },
    top_industries: [] as string[],
    top_locations: [] as LocationRow[],
  };

  try {
    const countResult = await db.execute<CountRow>(sql`
      SELECT COUNT(*) AS total FROM (
        SELECT DISTINCT customer_id FROM orders WHERE business_id = ${businessId}
        UNION
        SELECT DISTINCT client_id FROM appointments WHERE business_id = ${businessId}
      ) sub
    `);
    const totalCustomers = Number(countResult.rows[0]?.total ?? 0);
    if (totalCustomers === 0) return res.json(emptyResponse);

    const [profileResult, locationResult] = await Promise.all([
      db.execute<ConsumerProfileRow>(sql`
        SELECT gender, date_of_birth::text, shopping_frequency, selected_industries
        FROM users
        WHERE id IN (
          SELECT DISTINCT customer_id FROM orders WHERE business_id = ${businessId}
          UNION
          SELECT DISTINCT client_id FROM appointments WHERE business_id = ${businessId}
        )
        AND (date_of_birth IS NOT NULL OR gender IS NOT NULL OR shopping_frequency IS NOT NULL)
      `),
      db.execute<LocationRow>(sql`
        SELECT u.city, u.state, u.zip_code, COUNT(*)::int AS customer_count
        FROM users u
        WHERE u.id IN (
          SELECT DISTINCT customer_id FROM orders WHERE business_id = ${businessId}
          UNION
          SELECT DISTINCT client_id FROM appointments WHERE business_id = ${businessId}
        )
        AND u.city IS NOT NULL
        GROUP BY u.city, u.state, u.zip_code
        ORDER BY customer_count DESC
        LIMIT 10
      `),
    ]);

    const profiles = profileResult.rows;

    const gender = { male: 0, female: 0, non_binary: 0, prefer_not_to_say: 0, unknown: 0 };
    const ageRanges: Record<string, number> = { "18-24": 0, "25-34": 0, "35-44": 0, "45+": 0, unknown: 0 };
    const freqCounts: Record<string, number> = { rarely: 0, monthly: 0, weekly: 0, multiple_times_a_week: 0 };
    const industryCounts: Record<string, number> = {};

    for (const p of profiles) {
      const g = p.gender ? toSnake(p.gender) : "unknown";
      if (g in gender) (gender as Record<string, number>)[g]++;
      else gender.unknown++;

      const bucket = ageBucket(p.date_of_birth);
      ageRanges[bucket] = (ageRanges[bucket] ?? 0) + 1;

      const freq = p.shopping_frequency ? toSnake(p.shopping_frequency) : null;
      if (freq && freq in freqCounts) freqCounts[freq]++;

      const industries = Array.isArray(p.selected_industries) ? p.selected_industries : [];
      for (const ind of industries) {
        industryCounts[ind] = (industryCounts[ind] ?? 0) + 1;
      }
    }

    const topIndustries = Object.entries(industryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    return res.json({
      total_customers: totalCustomers,
      gender,
      age_ranges: ageRanges,
      shopping_frequency: freqCounts,
      top_industries: topIndustries,
      top_locations: locationResult.rows,
    });
  } catch (error) {
    console.error("[vendorAnalytics] /audience error:", error);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

// ─── GET /photographer-match ─────────────────────────────────────────────────

interface IndustryRow {
  selected_industries: string[] | null;
}

interface PhotographerRow {
  id: string;
  name: string;
  username: string | null;
  profile_image_url: string | null;
  specialties: string[] | null;
  rating: number;
  review_count: number;
  selected_industries: string[] | null;
}

router.get("/photographer-match", async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const businessId = authReq.user?.businessId;
  if (!businessId) return res.status(403).json({ error: "business_role_required" });

  try {
    const industryResult = await db.execute<IndustryRow>(sql`
      SELECT selected_industries
      FROM users
      WHERE id IN (
        SELECT DISTINCT customer_id FROM orders WHERE business_id = ${businessId}
        UNION
        SELECT DISTINCT client_id FROM appointments WHERE business_id = ${businessId}
      )
      AND selected_industries IS NOT NULL
    `);

    const industryCounts: Record<string, number> = {};
    for (const row of industryResult.rows) {
      const industries = Array.isArray(row.selected_industries) ? row.selected_industries : [];
      for (const ind of industries) {
        industryCounts[ind] = (industryCounts[ind] ?? 0) + 1;
      }
    }

    const vendorTopIndustries = Object.entries(industryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    if (vendorTopIndustries.length === 0) return res.json({ matches: [] });

    const photographerResult = await db.execute<PhotographerRow>(sql`
      SELECT
        u.id,
        u.name,
        u.username,
        u.profile_image_url,
        p.specialties,
        p.rating,
        p.review_count,
        u.selected_industries
      FROM photographers p
      JOIN users u ON u.id = p.user_id
      WHERE u.selected_industries IS NOT NULL
        AND u.is_active = true
      LIMIT 50
    `);

    const scored = photographerResult.rows
      .map((p) => {
        const theirIndustries = Array.isArray(p.selected_industries) ? p.selected_industries : [];
        const overlap = theirIndustries.filter((ind) => vendorTopIndustries.includes(ind));
        const match_score = overlap.length / vendorTopIndustries.length;
        const match_percent = Math.round(match_score * 100);
        return {
          photographer_id: p.id,
          name: p.name,
          username: p.username,
          profile_image_url: p.profile_image_url,
          specialty: Array.isArray(p.specialties) && p.specialties.length > 0 ? p.specialties[0] : null,
          rating: p.rating,
          review_count: p.review_count,
          match_score,
          match_percent,
        };
      })
      .filter((p) => p.match_percent > 0)
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, 5);

    return res.json({ matches: scored });
  } catch (error) {
    console.error("[vendorAnalytics] /photographer-match error:", error);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

export default router;
