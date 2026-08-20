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
  const businessId = authReq.user?.businessId
    ?? (authReq.user?.isAdmin ? req.headers['x-business-id'] as string : undefined);
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
  const businessId = authReq.user?.businessId
    ?? (authReq.user?.isAdmin ? req.headers['x-business-id'] as string : undefined);
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
  const businessId = authReq.user?.businessId
    ?? (authReq.user?.isAdmin ? req.headers['x-business-id'] as string : undefined);
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

// ─── GET /booking-health ─────────────────────────────────────────────────────

interface BookingHealthRow {
  total_submitted: number;
  confirmed_count: number;
  canceled_count: number;
}

interface AvailMinutesRow {
  available_minutes: number;
}

interface BookedMinutesRow {
  booked_minutes: number;
}

router.get("/booking-health", async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const businessId = authReq.user?.businessId
    ?? (authReq.user?.isAdmin ? req.headers['x-business-id'] as string : undefined);
  if (!businessId) return res.status(403).json({ error: "business_role_required" });

  try {
    const [healthResult, availResult, bookedResult] = await Promise.all([
      db.execute<BookingHealthRow>(sql`
        SELECT
          COUNT(*) FILTER (WHERE status NOT IN ('draft', 'pending_payment', 'expired'))::int AS total_submitted,
          COUNT(*) FILTER (WHERE status IN ('confirmed', 'completed', 'pending_payment', 'no_show'))::int AS confirmed_count,
          COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled_count
        FROM appointments
        WHERE business_id = ${businessId}
          AND created_at >= NOW() - INTERVAL '90 days'
      `),
      db.execute<AvailMinutesRow>(sql`
        SELECT COALESCE(SUM(
          EXTRACT(HOUR FROM end_time::time)::int * 60 + EXTRACT(MINUTE FROM end_time::time)::int
          - EXTRACT(HOUR FROM start_time::time)::int * 60 - EXTRACT(MINUTE FROM start_time::time)::int
        ), 0)::int AS available_minutes
        FROM weekly_availability
        WHERE provider_id = ${businessId}
          AND provider_type = 'business'
          AND is_active = true
      `),
      db.execute<BookedMinutesRow>(sql`
        SELECT COALESCE(SUM(COALESCE(duration_minutes, 60)), 0)::int AS booked_minutes
        FROM appointments
        WHERE business_id = ${businessId}
          AND status IN ('confirmed', 'completed', 'pending_payment', 'no_show')
          AND appointment_date >= TO_CHAR(DATE_TRUNC('week', NOW()), 'YYYY-MM-DD')
          AND appointment_date < TO_CHAR(DATE_TRUNC('week', NOW()) + INTERVAL '7 days', 'YYYY-MM-DD')
      `),
    ]);

    const h = healthResult.rows[0] ?? { total_submitted: 0, confirmed_count: 0, canceled_count: 0 };
    const total = Number(h.total_submitted);
    const confirmed = Number(h.confirmed_count);
    const canceled = Number(h.canceled_count);

    const conversion_rate = total > 0 ? Math.round((confirmed / total) * 100) : 0;
    const cancelable = confirmed + canceled;
    const cancellation_rate = cancelable > 0 ? Math.round((canceled / cancelable) * 100) : 0;

    const avail_minutes = Number(availResult.rows[0]?.available_minutes ?? 0);
    const booked_minutes = Number(bookedResult.rows[0]?.booked_minutes ?? 0);
    const calendar_utilization = avail_minutes > 0 ? Math.round((booked_minutes / avail_minutes) * 100) : 0;

    return res.json({
      conversion_rate,
      cancellation_rate,
      calendar_utilization,
      booked_count: confirmed,
      available_hours: Math.round(avail_minutes / 60),
    });
  } catch (error) {
    console.error("[vendorAnalytics] /booking-health error:", error);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

// ─── GET /revenue-by-service ──────────────────────────────────────────────────

interface RevenueServiceRow {
  service: string;
  booking_count: number;
  revenue_cents: number;
}

router.get("/revenue-by-service", async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const businessId = authReq.user?.businessId
    ?? (authReq.user?.isAdmin ? req.headers['x-business-id'] as string : undefined);
  if (!businessId) return res.status(403).json({ error: "business_role_required" });

  try {
    const result = await db.execute<RevenueServiceRow>(sql`
      SELECT
        COALESCE(service_name, 'Other') AS service,
        COUNT(*)::int AS booking_count,
        COALESCE(SUM(vendor_net), 0)::int AS revenue_cents
      FROM appointments
      WHERE business_id = ${businessId}
        AND status IN ('confirmed', 'completed', 'pending_payment', 'no_show')
        AND appointment_date >= TO_CHAR(DATE_TRUNC('month', NOW()), 'YYYY-MM-DD')
        AND appointment_date < TO_CHAR(DATE_TRUNC('month', NOW()) + INTERVAL '1 month', 'YYYY-MM-DD')
      GROUP BY service_name
      ORDER BY revenue_cents DESC
      LIMIT 10
    `);

    return res.json({
      services: result.rows.map((r) => ({
        service: r.service,
        booking_count: Number(r.booking_count),
        revenue_cents: Number(r.revenue_cents),
      })),
    });
  } catch (error) {
    console.error("[vendorAnalytics] /revenue-by-service error:", error);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

// ─── GET /peak-times ─────────────────────────────────────────────────────────

interface PeakTimesRow {
  day_of_week: number;
  time_slot: string;
  booking_count: number;
}

router.get("/peak-times", async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const businessId = authReq.user?.businessId
    ?? (authReq.user?.isAdmin ? req.headers['x-business-id'] as string : undefined);
  if (!businessId) return res.status(403).json({ error: "business_role_required" });

  try {
    const result = await db.execute<PeakTimesRow>(sql`
      SELECT
        EXTRACT(DOW FROM appointment_date::date)::int AS day_of_week,
        CASE
          WHEN appointment_time < '12:00' THEN 'morning'
          WHEN appointment_time < '17:00' THEN 'afternoon'
          WHEN appointment_time < '21:00' THEN 'evening'
          ELSE 'night'
        END AS time_slot,
        COUNT(*)::int AS booking_count
      FROM appointments
      WHERE business_id = ${businessId}
        AND status IN ('confirmed', 'completed', 'pending_payment', 'no_show')
        AND created_at >= NOW() - INTERVAL '90 days'
      GROUP BY day_of_week, time_slot
    `);

    const heatmap = result.rows.map((r) => ({
      day_of_week: Number(r.day_of_week),
      time_slot: r.time_slot,
      booking_count: Number(r.booking_count),
    }));

    const dayTotals: Record<number, number> = {};
    const slotTotals: Record<string, number> = {};
    for (const row of heatmap) {
      dayTotals[row.day_of_week] = (dayTotals[row.day_of_week] ?? 0) + row.booking_count;
      slotTotals[row.time_slot] = (slotTotals[row.time_slot] ?? 0) + row.booking_count;
    }

    const allDays = [0, 1, 2, 3, 4, 5, 6];
    let busiest_day: string | null = null;
    let most_open_day: string | null = null;
    if (Object.keys(dayTotals).length > 0) {
      const busiestDow = allDays.reduce((a, b) => (dayTotals[a] ?? 0) >= (dayTotals[b] ?? 0) ? a : b);
      busiest_day = DAY_LABELS[busiestDow];
      const openestDow = allDays.reduce((a, b) => (dayTotals[a] ?? 0) <= (dayTotals[b] ?? 0) ? a : b);
      most_open_day = DAY_LABELS[openestDow];
    }

    let busiest_window: string | null = null;
    if (Object.keys(slotTotals).length > 0) {
      busiest_window = Object.entries(slotTotals).sort((a, b) => b[1] - a[1])[0][0];
    }

    return res.json({ heatmap, busiest_day, busiest_window, most_open_day });
  } catch (error) {
    console.error("[vendorAnalytics] /peak-times error:", error);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

// ─── GET /revenue-forecast ────────────────────────────────────────────────────

interface MonthRevenueRow {
  month: string;
  revenue_cents: number;
}

interface MtdRow {
  mtd_cents: number;
}

router.get("/revenue-forecast", async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const businessId = authReq.user?.businessId
    ?? (authReq.user?.isAdmin ? req.headers['x-business-id'] as string : undefined);
  if (!businessId) return res.status(403).json({ error: "business_role_required" });

  try {
    const [historicalResult, mtdResult] = await Promise.all([
      db.execute<MonthRevenueRow>(sql`
        SELECT
          TO_CHAR(appointment_date::date, 'YYYY-MM') AS month,
          COALESCE(SUM(vendor_net), 0)::int AS revenue_cents
        FROM appointments
        WHERE business_id = ${businessId}
          AND status IN ('confirmed', 'completed', 'pending_payment', 'no_show')
          AND appointment_date >= TO_CHAR(DATE_TRUNC('month', NOW()) - INTERVAL '3 months', 'YYYY-MM-DD')
          AND appointment_date < TO_CHAR(DATE_TRUNC('month', NOW()), 'YYYY-MM-DD')
        GROUP BY month
        ORDER BY month
      `),
      db.execute<MtdRow>(sql`
        SELECT COALESCE(SUM(vendor_net), 0)::int AS mtd_cents
        FROM appointments
        WHERE business_id = ${businessId}
          AND status IN ('confirmed', 'completed', 'pending_payment', 'no_show')
          AND appointment_date >= TO_CHAR(DATE_TRUNC('month', NOW()), 'YYYY-MM-DD')
          AND appointment_date < TO_CHAR(NOW()::date + 1, 'YYYY-MM-DD')
      `),
    ]);

    const historical = historicalResult.rows.map((r) => ({
      month: r.month,
      revenue_cents: Number(r.revenue_cents),
    }));

    const mtd_cents = Number(mtdResult.rows[0]?.mtd_cents ?? 0);
    const now = new Date();
    const current_day = now.getDate();
    const days_in_month = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daily_rate = current_day > 0 ? mtd_cents / current_day : 0;
    const remaining_days = days_in_month - current_day;
    const projected_month = Math.round(mtd_cents + daily_rate * remaining_days);
    const forecast_low = Math.round(projected_month * 0.85);
    const forecast_high = Math.round(projected_month * 1.15);
    const confidence = historical.length >= 3 ? "high" : historical.length >= 1 ? "medium" : "low";

    return res.json({ forecast_low, forecast_high, projected_month, confidence, historical, mtd_cents });
  } catch (error) {
    console.error("[vendorAnalytics] /revenue-forecast error:", error);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

// ─── GET /year-over-year ──────────────────────────────────────────────────────

interface YoyRow {
  month: string;
  revenue_cents: number;
}

router.get("/year-over-year", async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const businessId = authReq.user?.businessId
    ?? (authReq.user?.isAdmin ? req.headers['x-business-id'] as string : undefined);
  if (!businessId) return res.status(403).json({ error: "business_role_required" });

  try {
    const result = await db.execute<YoyRow>(sql`
      SELECT
        TO_CHAR(appointment_date::date, 'YYYY-MM') AS month,
        COALESCE(SUM(vendor_net), 0)::int AS revenue_cents
      FROM appointments
      WHERE business_id = ${businessId}
        AND status IN ('confirmed', 'completed', 'pending_payment', 'no_show')
        AND (
          (appointment_date >= TO_CHAR(DATE_TRUNC('month', NOW()) - INTERVAL '3 months', 'YYYY-MM-DD')
           AND appointment_date < TO_CHAR(DATE_TRUNC('month', NOW()), 'YYYY-MM-DD'))
          OR
          (appointment_date >= TO_CHAR(DATE_TRUNC('month', NOW()) - INTERVAL '15 months', 'YYYY-MM-DD')
           AND appointment_date < TO_CHAR(DATE_TRUNC('month', NOW()) - INTERVAL '12 months', 'YYYY-MM-DD'))
        )
      GROUP BY month
      ORDER BY month
    `);

    const byMonth = new Map<string, number>();
    for (const row of result.rows) {
      byMonth.set(row.month, Number(row.revenue_cents));
    }

    const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const months = [];
    for (let i = 3; i >= 1; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const current_month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const prev_d = new Date(d);
      prev_d.setFullYear(prev_d.getFullYear() - 1);
      const prev_month = `${prev_d.getFullYear()}-${String(prev_d.getMonth() + 1).padStart(2, "0")}`;
      const revenue_cents = byMonth.get(current_month) ?? 0;
      const yoy_revenue_cents = byMonth.has(prev_month) ? byMonth.get(prev_month)! : null;
      const yoy_delta =
        yoy_revenue_cents !== null && yoy_revenue_cents > 0
          ? Math.round(((revenue_cents - yoy_revenue_cents) / yoy_revenue_cents) * 100)
          : null;
      months.push({ month: current_month, label: MONTH_LABELS[d.getMonth()], revenue_cents, yoy_revenue_cents, yoy_delta });
    }

    return res.json({ months });
  } catch (error) {
    console.error("[vendorAnalytics] /year-over-year error:", error);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

// ─── GET /weekly ──────────────────────────────────────────────────────────────

interface WeeklyRow {
  label: string;
  week_start: string;
  revenue_cents: number;
  booking_count: number;
}

router.get("/weekly", async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const businessId = authReq.user?.businessId
    ?? (authReq.user?.isAdmin ? req.headers['x-business-id'] as string : undefined);
  if (!businessId) return res.status(403).json({ error: "business_role_required" });

  try {
    const result = await db.execute<WeeklyRow>(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('week', created_at), 'Mon DD') AS label,
        DATE_TRUNC('week', created_at)::text AS week_start,
        COALESCE(SUM(vendor_net), 0)::int AS revenue_cents,
        COUNT(*) FILTER (WHERE status IN ('confirmed','completed','pending_payment','no_show'))::int AS booking_count
      FROM appointments
      WHERE business_id = ${businessId}
        AND status IN ('confirmed','completed','pending_payment','no_show')
        AND created_at >= NOW() - INTERVAL '6 weeks'
      GROUP BY DATE_TRUNC('week', created_at)
      ORDER BY week_start ASC
    `);

    const WEEK_LABELS = ["5wk", "4wk", "3wk", "2wk", "Last", "This"];
    const rows = result.rows;
    const days = rows.map((r, i) => {
      const offset = rows.length - 1 - i;
      const label = offset === 0 ? "This" : offset === 1 ? "Last" : `${offset + 1}wk`;
      return {
        label,
        revenue_cents: Number(r.revenue_cents),
        booking_count: Number(r.booking_count),
        order_count: 0,
      };
    });

    return res.json({ days });
  } catch (error) {
    console.error("[vendorAnalytics] /weekly error:", error);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

// ─── GET /monthly ─────────────────────────────────────────────────────────────

interface MonthlyRow {
  label: string;
  month_start: string;
  revenue_cents: number;
  booking_count: number;
}

router.get("/monthly", async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const businessId = authReq.user?.businessId
    ?? (authReq.user?.isAdmin ? req.headers['x-business-id'] as string : undefined);
  if (!businessId) return res.status(403).json({ error: "business_role_required" });

  try {
    const result = await db.execute<MonthlyRow>(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS label,
        DATE_TRUNC('month', created_at)::text AS month_start,
        COALESCE(SUM(vendor_net), 0)::int AS revenue_cents,
        COUNT(*) FILTER (WHERE status IN ('confirmed','completed','pending_payment','no_show'))::int AS booking_count
      FROM appointments
      WHERE business_id = ${businessId}
        AND status IN ('confirmed','completed','pending_payment','no_show')
        AND created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month_start ASC
    `);

    const days = result.rows.map((r) => ({
      label: r.label,
      revenue_cents: Number(r.revenue_cents),
      booking_count: Number(r.booking_count),
      order_count: 0,
    }));

    return res.json({ days });
  } catch (error) {
    console.error("[vendorAnalytics] /monthly error:", error);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

export default router;
