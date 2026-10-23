# Coordinate Backfill + Keep Coordinates Current — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every business and photographer with a city gets a city-level map point, so city search (#362) reaches them by distance, and the point stays correct when they change their city.

**Architecture:** Reuse `cachedCityGeocode(city, state, { wait: true })` from `server/search/areaSearch.ts` (Nominatim, throttled, cached). Two save routes re-derive the point when city/state change. A one-off script fills the existing gaps: dry run by default, `--apply` writes only rows that still have no point.

**Tech Stack:** Express, Drizzle (neon-http, no transactions), tsx scripts, local scratch Postgres for tests.

**Spec:** Conversation 2026-10-23 (Legend: "LETS DO 1 FIRST" = coordinates for the businesses/photographers without them) + vault `Handoffs/2026-10-23 City Search & Location Privacy — Start Here.md` (Open / next).

## Global Constraints
- City-level points only (`city, state`), never a street geocode: several street fields are test data ("123 Main Street", "1986 9").
- Production writes only through the script's `--apply`, run by Legend after he approves the dry run. The script never overwrites a non-null point.
- Nominatim: 1 lookup per 1.1 s (existing throttle); the script and save routes use `{ wait: true }`.
- A failed lookup after a city change sets the point to null (city text match still finds the row), never keeps the old city's point.
- No change to response shapes; tests on localhost only.

## Review Focus
1. Business changes city but the lookup fails → point becomes null, not the old city's point.
2. A save that doesn't touch city/state (e.g. bio, hours) → no lookup, point unchanged.
3. State written as "Ny", "New York", "Fl" → normalized to the 2-letter code before lookup.
4. Script run twice → second run finds nothing to do (idempotent).
5. Row with a city but no state ("Queens") → looked up without state; dry run shows the result so Legend can reject a wrong match.

---

### Task 1: Re-derive the point when a business or photographer changes city

**Files:**
- Modify: `server/routes.ts` (`PATCH /api/vendor/my-business`, ≈:12341)
- Modify: `server/Photographers/photographers.controller.ts` (`updateMe`, ≈:181-202)
- Create: `.dev/geocode-stub-preload.mjs` (test only: answers Nominatim from a fixed table)
- Test: `server/geo/coordinateRefresh.http.test.ts`

**Interfaces:**
- Consumes: `cachedCityGeocode(city: string, state: string | null, opts?: { wait?: boolean })`, `normalizeState(raw: unknown): string | null` (areaSearch.ts)
- Produces: `refreshCityPoint(current: { city?: string | null; state?: string | null }, updates: { city?: string | null; state?: string | null }): Promise<{ latitude: number | null; longitude: number | null } | undefined>` in `server/geo/cityPoint.ts`. Returns `undefined` when neither city nor state is in `updates` (nothing to change).

- [ ] Step 1: Write the failing HTTP test: business PATCH `{ city: "Freeport", state: "NY" }` → row lat/lng = stub's Freeport point; PATCH `{ description: "x" }` → lat/lng unchanged and stub call count unchanged; PATCH `{ city: "Unknownville" }` (stub returns nothing) → lat/lng null; same three cases for `PATCH /api/photographers/me`; `{ state: "Ny" }` → stub received `NY`.
- [ ] Step 2: Run it (backend booted with the stub preload) → fails (points never change).
- [ ] Step 3: Implement `refreshCityPoint` and call it in both routes after validation, merging its result into the update.
- [ ] Step 4: Run the new test → pass; rerun `citySearchPrivacy.http.test.ts`, `industryEdit.http.test.ts`, `photographerSignupDetails.http.test.ts`, `coverMedia.http.test.ts` → same as main.
- [ ] Step 5: Commit.

### Task 2: One-off backfill script (dry run first)

**Files:**
- Create: `scripts/backfill-city-coordinates.ts`
- Test: `scripts/backfill-city-coordinates.test.ts` (scratch DB + stub preload)

**Interfaces:**
- Consumes: `cachedCityGeocode`, `normalizeState`.
- Produces: CLI `npx tsx scripts/backfill-city-coordinates.ts [--apply] [--only=<id,id>] [--skip=<id,id>]`. Prints one line per row: kind, id, name, "city, ST" looked up, proposed lat/lng, matched place name. `--apply` runs `UPDATE … SET latitude, longitude WHERE id = $1 AND latitude IS NULL`.

- [ ] Step 1: Failing test: dry run on 3 seeded rows (one with no state) prints 3 proposals and writes nothing; `--apply` writes them; second `--apply` reports 0 rows; `--skip` leaves that row null; a row whose lookup fails is reported "no match" and stays null.
- [ ] Step 2: Run → fails (script missing).
- [ ] Step 3: Implement.
- [ ] Step 4: Run → pass. Commit.
- [ ] Step 5 (Legend): after merge, in Render Shell run the dry run, paste the output to Claude, review together, then `--apply`. Claude verifies the rows read-only in Neon afterwards.
