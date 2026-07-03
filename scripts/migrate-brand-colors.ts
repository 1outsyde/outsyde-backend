/**
 * One-time migration: convert raw-hex brand_colors → curated color ID shape.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/migrate-brand-colors.ts
 *   # or, with the local dev proxy:
 *   DATABASE_URL="postgresql://outsyde:outsyde@localhost:5432/outsyde" \
 *     NODE_OPTIONS="--import ./.dev/neon-preload.mjs" \
 *     npx tsx scripts/migrate-brand-colors.ts
 *
 * Safety guarantees:
 *   - Idempotent: rows that already carry a "type" key are skipped.
 *   - Unmapped hex values are logged and left untouched.
 *   - Null brand_colors rows are ignored.
 *   - Dry-run mode: set DRY_RUN=1 to log without writing.
 */

import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required.");
  process.exit(1);
}

const DRY_RUN = process.env.DRY_RUN === "1";
if (DRY_RUN) {
  console.log("DRY_RUN=1 — no writes will be performed.\n");
}

// ─── Hex → curated ID mapping table ──────────────────────────────────────────
// Only the 5 values confirmed in the audit are mapped.
// Any other value is flagged for manual review.
const HEX_TO_COLOR_ID: Record<string, { type: "solid" | "gradient"; id: string }> = {
  // businesses
  "#eab308": { type: "solid", id: "sunset_gold" },
  "#ec4899": { type: "solid", id: "rose_pink" },
  "#8b5cf6": { type: "solid", id: "royal_purple" },
  // photographers
  "#14b8a6": { type: "solid", id: "teal" },
  "#22c55e": { type: "solid", id: "forest_green" },
};

type LegacyBrandColors = { primary?: string; secondary?: string } | null;
type NewBrandColors = { type: "solid" | "gradient"; id: string } | null;

interface Row {
  id: string;
  name: string;
  brand_colors: LegacyBrandColors | NewBrandColors | null;
}

async function migrateTable(
  sql: ReturnType<typeof neon>,
  table: "businesses" | "photographers",
  nameCol: string,
): Promise<void> {
  console.log(`\n──── ${table} ────────────────────────────────`);

  const rows = await sql<Row[]>(
    `SELECT id, ${nameCol} AS name, brand_colors FROM ${table} WHERE brand_colors IS NOT NULL`,
  );

  if (rows.length === 0) {
    console.log("  No rows with brand_colors set.");
    return;
  }

  let updated = 0;
  let skipped = 0;
  let unmapped = 0;

  for (const row of rows) {
    // Neon HTTP driver may return JSONB as a raw JSON string or as a parsed object;
    // normalise to a plain JS object before any key checks.
    let colors: any = row.brand_colors;
    if (typeof colors === "string") {
      try {
        colors = JSON.parse(colors);
      } catch {
        console.log(`  SKIP (unparseable JSON)  id=${row.id}  name="${row.name}"  raw=${JSON.stringify(row.brand_colors)}`);
        skipped++;
        continue;
      }
    }

    // Already migrated: has a "type" key → skip (idempotency guard)
    if (colors && typeof colors === "object" && "type" in colors) {
      console.log(`  SKIP (already migrated)  id=${row.id}  name="${row.name}"  current=${JSON.stringify(colors)}`);
      skipped++;
      continue;
    }

    const legacy = colors as LegacyBrandColors;
    const hexRaw = legacy?.primary;

    if (!hexRaw) {
      // brand_colors is non-null but has no primary — log and skip
      console.log(`  SKIP (no primary hex)    id=${row.id}  name="${row.name}"  raw=${JSON.stringify(legacy)}`);
      skipped++;
      continue;
    }

    // Normalise to lowercase for lookup
    const hex = hexRaw.toLowerCase();
    const mapped = HEX_TO_COLOR_ID[hex];

    if (!mapped) {
      console.log(
        `  UNMAPPED — manual review needed  id=${row.id}  name="${row.name}"  primary="${hexRaw}"`,
      );
      unmapped++;
      continue;
    }

    const newValue: NewBrandColors = { type: mapped.type, id: mapped.id };
    console.log(
      `  UPDATE  id=${row.id}  name="${row.name}"  ${hexRaw} → ${JSON.stringify(newValue)}`,
    );

    if (!DRY_RUN) {
      await sql(
        `UPDATE ${table} SET brand_colors = $1::jsonb WHERE id = $2`,
        [JSON.stringify(newValue), row.id],
      );
    }
    updated++;
  }

  console.log(`\n  Summary: ${updated} updated, ${skipped} skipped, ${unmapped} unmapped (manual review needed)`);
}

async function main(): Promise<void> {
  const sql = neon(DATABASE_URL!);

  await migrateTable(sql, "businesses", "name");
  await migrateTable(sql, "photographers", "display_name");

  console.log("\n✅ Migration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
