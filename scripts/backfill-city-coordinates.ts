/**
 * One-off: give every business and photographer that has a city but no map point a CITY-LEVEL point,
 * so city search (#362) reaches them by distance. 2026-10-23.
 *
 * Dry run by default (reads only, prints what it would write). --apply writes, and only to rows whose
 * point is still empty (UPDATE ... WHERE latitude IS NULL), so it can be run twice safely.
 *
 *   npx tsx scripts/backfill-city-coordinates.ts                      # dry run
 *   npx tsx scripts/backfill-city-coordinates.ts --apply              # write
 *   --skip=<id,id>       leave these rows alone
 *   --only=<id,id>       consider only these rows
 *   --state=<id>:<ST>    look this row up with this state (the row's saved state is not changed)
 *
 * Needs DATABASE_URL and internet access to nominatim.openstreetmap.org (Render has it).
 * Lookups go one per 1.1 s through the same throttled lookup the app uses.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../server/db";
import { businesses, photographers } from "@shared/schema";
import { cachedCityGeocode, normalizeState } from "../server/search/areaSearch";

const APPLY = process.argv.includes("--apply");
const listArg = (flag: string) => {
  const raw = process.argv.find((a) => a.startsWith(`${flag}=`));
  return raw ? raw.slice(flag.length + 1).split(",").map((s) => s.trim()).filter(Boolean) : [];
};
const SKIP = new Set(listArg("--skip"));
const ONLY = new Set(listArg("--only"));
const STATE_OVERRIDES = new Map(
  process.argv
    .filter((a) => a.startsWith("--state="))
    .map((a) => a.slice("--state=".length).split(":"))
    .filter((p) => p.length === 2 && p[0] && p[1])
    .map(([id, st]) => [id.trim(), st.trim()] as [string, string]),
);

type Row = { kind: "business" | "photographer"; id: string; name: string; city: string | null; state: string | null };

async function main() {
  console.log(`[backfill] ${APPLY ? "APPLY: writing points" : "DRY RUN: nothing will be written"}`);
  const missing = (lat: any, lng: any) => or(isNull(lat), isNull(lng));
  const bizRows = await db
    .select({ id: businesses.id, name: businesses.name, city: businesses.city, state: businesses.state })
    .from(businesses)
    .where(missing(businesses.latitude, businesses.longitude));
  const phRows = await db
    .select({ id: photographers.id, name: photographers.displayName, city: photographers.city, state: photographers.state })
    .from(photographers)
    .where(missing(photographers.latitude, photographers.longitude));
  const rows: Row[] = [
    ...bizRows.map((r) => ({ kind: "business" as const, ...r, name: r.name ?? "" })),
    ...phRows.map((r) => ({ kind: "photographer" as const, ...r, name: r.name ?? "" })),
  ].filter((r) => (ONLY.size ? ONLY.has(r.id) : true));

  let wrote = 0;
  let proposed = 0;
  for (const r of rows) {
    const label = `${r.kind.padEnd(12)} ${r.id}  ${r.name.trim()}`;
    if (SKIP.has(r.id)) { console.log(`SKIP      ${label}`); continue; }
    const city = (r.city ?? "").trim().replace(/\s+/g, " ");
    if (!city) { console.log(`NO CITY   ${label}`); continue; }
    const rawState = STATE_OVERRIDES.get(r.id) ?? r.state;
    const state = normalizeState(rawState) ?? ((rawState ?? "").trim() || null);
    const point = await cachedCityGeocode(city, state, { wait: true });
    const asked = `${city}${state ? `, ${state}` : ""}`;
    if (!point) { console.log(`NO MATCH  ${label}  looked up "${asked}"`); continue; }
    proposed++;
    const map = `https://www.google.com/maps?q=${point.latitude},${point.longitude}`;
    console.log(`${APPLY ? "WRITE    " : "WOULD SET"} ${label}  "${asked}" -> ${point.latitude}, ${point.longitude}  ${map}`);
    if (APPLY) {
      const table = r.kind === "business" ? businesses : photographers;
      const res = await db
        .update(table)
        .set({ latitude: point.latitude, longitude: point.longitude })
        .where(and(eq(table.id, r.id), isNull(table.latitude), isNull(table.longitude)))
        .returning({ id: table.id });
      wrote += res.length;
      if (!res.length) console.log(`          (not written: the row got a point meanwhile)`);
    }
  }
  console.log(`[backfill] rows without a point: ${rows.length}, points found: ${proposed}${APPLY ? `, written: ${wrote}` : ""}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[backfill] failed:", e); process.exit(1); });
