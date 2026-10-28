// Profile / brand color rules (color wheel build, 2026-10-28).
//
// One stored shape for every account type:
//   businesses.brand_colors, photographers.brand_colors, users.profile_color (migration 079)
//
//   { type: "solid",  id: "<preset id>" }   one of the 16 preset swatches (the only shape before this build)
//   { type: "custom", hex: "#RRGGBB" }      a color wheel pick
//   null                                     nothing chosen, clients show gold
//
// The preset ids must match OutsydeCapture constants/colorOptions.ts SOLID_COLOR_IDS.
//
// Old app versions only understand "solid". New app versions send `v: 2` with every color they save.
// A save WITHOUT `v: 2` is from an old app version: when the stored color is a wheel color, that save's
// color is ignored (the old Storefront Editor sends its color on every branding save and would otherwise
// overwrite a wheel color with gold). `v` is never stored. null always applies (old apps never send it).

import { z } from "zod";

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

export type StoredColor =
  | { type: "solid"; id: (typeof SOLID_COLOR_IDS)[number] }
  | { type: "custom"; hex: string };

const solidInput = z.object({
  type: z.literal("solid"),
  id: z.enum(SOLID_COLOR_IDS),
  v: z.literal(2).optional(),
});

const customInput = z.object({
  type: z.literal("custom"),
  hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "hex must look like #RRGGBB"),
  v: z.literal(2).optional(),
});

export const colorInputSchema = z.discriminatedUnion("type", [solidInput, customInput]).nullable();

export type ColorDecision =
  | { ok: true; apply: true; value: StoredColor | null }
  | { ok: true; apply: false }
  | { ok: false; error: string };

/**
 * Decide what a save should do with an incoming color.
 *   ok:false               → reject the save (400)
 *   ok:true, apply:false   → leave the stored color alone (old app version vs a stored wheel color)
 *   ok:true, apply:true    → store `value`
 */
export function decideColorUpdate(incoming: unknown, stored: unknown): ColorDecision {
  const parsed = colorInputSchema.safeParse(incoming);
  if (!parsed.success) {
    return { ok: false, error: "Color must be a preset or a #RRGGBB color" };
  }
  const data = parsed.data;
  // null (back to gold) is always applied: no old app version ever sends null for a color.
  if (data === null) return { ok: true, apply: true, value: null };
  const fromNewApp = data.v === 2;
  const storedIsCustom =
    !!stored && typeof stored === "object" && (stored as { type?: unknown }).type === "custom";
  if (!fromNewApp && storedIsCustom) {
    return { ok: true, apply: false };
  }
  if (data.type === "solid") return { ok: true, apply: true, value: { type: "solid", id: data.id } };
  return { ok: true, apply: true, value: { type: "custom", hex: data.hex.toUpperCase() } };
}
