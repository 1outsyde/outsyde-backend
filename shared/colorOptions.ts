/**
 * Curated brand color options for business and photographer profiles.
 *
 * BACKEND SOURCE OF TRUTH — IDs are validated server-side on every PATCH.
 * Frontend must maintain a matching lookup table (by ID) to resolve hex values.
 *
 * ─── SOLID SWATCHES ───────────────────────────────────────────────────────────
 * ID                  Dark hex    Light hex
 * sunset_gold         #b45309     #fef9c3
 * rose_pink           #be185d     #fce7f3
 * ocean_blue          #1d4ed8     #dbeafe
 * forest_green        #15803d     #dcfce7
 * royal_purple        #6d28d9     #ede9fe
 * sunset_orange       #c2410c     #ffedd5
 * teal                #0f766e     #ccfbf1
 * slate_gray          #475569     #f1f5f9
 * ruby_red            #b91c1c     #fee2e2
 * sky_cyan            #0369a1     #e0f2fe
 * amber               #b45309     #fef3c7
 * indigo              #3730a3     #e0e7ff
 * coral               #c2410c     #ffe4e6
 * lime                #3f6212     #ecfccb
 * plum                #86198f     #fae8ff
 * charcoal_emerald    #064e3b     #d1fae5
 *
 * ─── GRADIENTS ────────────────────────────────────────────────────────────────
 * ID              Dark stops (from → to)           Light stops (from → to)
 * dusk_fade       #4c0519 → #7c3aed               #fce7f3 → #ede9fe
 * sunset_blaze    #7c2d12 → #b45309               #ffedd5 → #fef9c3
 * ocean_depth     #1e3a5f → #0f766e               #dbeafe → #ccfbf1
 * emerald_glow    #064e3b → #15803d               #d1fae5 → #dcfce7
 * golden_hour     #78350f → #b45309               #fef3c7 → #fef9c3
 * midnight_rose   #4a044e → #be185d               #fae8ff → #fce7f3
 */

export const SOLID_COLOR_IDS = [
  "sunset_gold",
  "rose_pink",
  "ocean_blue",
  "forest_green",
  "royal_purple",
  "sunset_orange",
  "teal",
  "slate_gray",
  "ruby_red",
  "sky_cyan",
  "amber",
  "indigo",
  "coral",
  "lime",
  "plum",
  "charcoal_emerald",
] as const;

export const GRADIENT_COLOR_IDS = [
  "dusk_fade",
  "sunset_blaze",
  "ocean_depth",
  "emerald_glow",
  "golden_hour",
  "midnight_rose",
] as const;

export type SolidColorId = (typeof SOLID_COLOR_IDS)[number];
export type GradientColorId = (typeof GRADIENT_COLOR_IDS)[number];
export type ColorId = SolidColorId | GradientColorId;
