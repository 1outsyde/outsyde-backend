/**
 * Product options (Length, Size, Color) and the variants built from them.
 * Migration 049. Pure functions only (no db, no Express) so they can be
 * tested directly: server/productOptions.test.ts.
 *
 * Model, same idea as Shopify:
 *   - a product has up to 3 options, each with an ordered list of values
 *   - each variant stores the value it uses for option 1, 2 and 3
 *   - a variant's priceCents may be null, meaning "use the product's price",
 *     so 15 colors at one price are priced once on the product
 *
 * Variants are never hard-deleted here: a combination the vendor removes is
 * switched off (isActive = false), so cart_items and past orders that point
 * at it keep working.
 */

export const MAX_OPTIONS = 3;
export const MAX_VALUES_PER_OPTION = 50;
export const MAX_VARIANTS = 250;
export const MAX_NAME_LENGTH = 40;
export const MAX_VARIANT_PRICE_CENTS = 10_000_000; // $100,000

export interface OptionValueInput {
  value: string;
  swatchHex?: string | null;
}
export interface OptionInput {
  name: string;
  values: OptionValueInput[];
}
export interface VariantInput {
  id?: string | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  /** null = use the product's price */
  priceCents: number | null;
  compareAtPriceCents?: number | null;
  inventory?: number | null;
  trackInventory?: boolean;
  sku?: string | null;
  imageUrl?: string | null;
  isActive?: boolean;
}

export interface ExistingVariant {
  id: string;
  label: string;
  priceCents: number | null;
  inventory: number | null;
  isActive: boolean | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

export interface NormalizedOption {
  position: number; // 1..3
  name: string;
  values: Array<{ value: string; swatchHex: string | null }>;
}
export interface NormalizedVariant {
  id: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  label: string;
  priceCents: number | null;
  compareAtPriceCents: number | null;
  inventory: number | null;
  trackInventory: boolean;
  sku: string | null;
  imageUrl: string | null;
  isActive: boolean;
  sortOrder: number;
}

export type OptionsError = { code: 'INVALID_OPTIONS' | 'INVALID_VARIANTS' | 'INVALID_VARIANT_ID'; message: string };

const HEX = /^#[0-9a-fA-F]{6}$/;
const clean = (s: unknown): string => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');
const key = (s: string) => s.toLowerCase();

export function validateOptionsPayload(
  options: OptionInput[],
  variants: VariantInput[],
):
  | { ok: true; options: NormalizedOption[]; variants: NormalizedVariant[] }
  | { ok: false; error: OptionsError } {
  const bad = (code: OptionsError['code'], message: string) => ({ ok: false as const, error: { code, message } });

  if (!Array.isArray(options) || options.length > MAX_OPTIONS) {
    return bad('INVALID_OPTIONS', `Use up to ${MAX_OPTIONS} options`);
  }
  if (!Array.isArray(variants) || variants.length > MAX_VARIANTS) {
    return bad('INVALID_VARIANTS', `Use up to ${MAX_VARIANTS} variations per product`);
  }

  const normOptions: NormalizedOption[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < options.length; i++) {
    const name = clean(options[i]?.name);
    if (!name || name.length > MAX_NAME_LENGTH) return bad('INVALID_OPTIONS', `Option ${i + 1} needs a name of up to ${MAX_NAME_LENGTH} characters`);
    if (seenNames.has(key(name))) return bad('INVALID_OPTIONS', `"${name}" is used twice`);
    seenNames.add(key(name));
    const rawValues = Array.isArray(options[i]?.values) ? options[i].values : [];
    if (rawValues.length === 0) return bad('INVALID_OPTIONS', `Add at least one ${name}`);
    if (rawValues.length > MAX_VALUES_PER_OPTION) return bad('INVALID_OPTIONS', `Use up to ${MAX_VALUES_PER_OPTION} values for ${name}`);
    const seenValues = new Set<string>();
    const values: NormalizedOption['values'] = [];
    for (const rv of rawValues) {
      const value = clean(rv?.value);
      if (!value || value.length > MAX_NAME_LENGTH) return bad('INVALID_OPTIONS', `Each ${name} needs a value of up to ${MAX_NAME_LENGTH} characters`);
      if (seenValues.has(key(value))) return bad('INVALID_OPTIONS', `${name} "${value}" is listed twice`);
      seenValues.add(key(value));
      const hex = rv?.swatchHex == null || rv.swatchHex === '' ? null : String(rv.swatchHex);
      if (hex !== null && !HEX.test(hex)) return bad('INVALID_OPTIONS', `Swatch color for ${value} must look like #1A3C34`);
      values.push({ value, swatchHex: hex });
    }
    normOptions.push({ position: i + 1, name, values });
  }

  if (normOptions.length === 0 && variants.length > 0) {
    return bad('INVALID_VARIANTS', 'Add an option before adding variations');
  }

  const normVariants: NormalizedVariant[] = [];
  const seenCombos = new Set<string>();
  const seenIds = new Set<string>();
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const picked: (string | null)[] = [null, null, null];
    for (let p = 0; p < MAX_OPTIONS; p++) {
      const raw = clean((v as any)?.[`option${p + 1}`]);
      const opt = normOptions[p];
      if (!opt) {
        if (raw) return bad('INVALID_VARIANTS', `Variation ${i + 1} has a value for an option that doesn't exist`);
        continue;
      }
      const match = opt.values.find((x) => key(x.value) === key(raw));
      if (!match) return bad('INVALID_VARIANTS', `Variation ${i + 1} needs a ${opt.name} from the list`);
      picked[p] = match.value; // canonical spelling from the option list
    }
    const combo = picked.map((x) => (x ? key(x) : '')).join('\u0000');
    if (seenCombos.has(combo)) return bad('INVALID_VARIANTS', `${picked.filter(Boolean).join(' / ')} is listed twice`);
    seenCombos.add(combo);

    const id = v.id ? String(v.id) : null;
    if (id) {
      if (seenIds.has(id)) return bad('INVALID_VARIANT_ID', 'The same variation id is listed twice');
      seenIds.add(id);
    }

    const price = v.priceCents;
    if (price !== null && (typeof price !== 'number' || !Number.isInteger(price) || price <= 0 || price > MAX_VARIANT_PRICE_CENTS)) {
      return bad('INVALID_VARIANTS', `Variation ${i + 1} needs a price above $0, or leave it blank to use the product price`);
    }
    const cap = v.compareAtPriceCents ?? null;
    if (cap !== null && (!Number.isInteger(cap) || cap <= 0)) return bad('INVALID_VARIANTS', `Variation ${i + 1} has an invalid compare-at price`);
    const inv = v.inventory ?? null;
    if (inv !== null && (!Number.isInteger(inv) || inv < 0)) return bad('INVALID_VARIANTS', `Variation ${i + 1} stock must be 0 or more`);
    const img = v.imageUrl == null || v.imageUrl === '' ? null : String(v.imageUrl);
    if (img !== null && (!/^https:\/\//.test(img) || img.length > 2000)) return bad('INVALID_VARIANTS', `Variation ${i + 1} photo must be an uploaded image`);
    const sku = v.sku == null || v.sku === '' ? null : clean(v.sku).slice(0, 64);

    normVariants.push({
      id,
      option1: picked[0],
      option2: picked[1],
      option3: picked[2],
      label: picked.filter(Boolean).join(' / '),
      priceCents: price,
      compareAtPriceCents: cap,
      inventory: inv,
      trackInventory: v.trackInventory !== false,
      sku,
      imageUrl: img,
      isActive: v.isActive !== false,
      sortOrder: i,
    });
  }

  return { ok: true, options: normOptions, variants: normVariants };
}

const comboKey = (v: { option1: string | null; option2: string | null; option3: string | null }) =>
  [v.option1, v.option2, v.option3].map((x) => (x ? key(x) : '')).join('\u0000');

export interface VariantSyncPlan {
  updates: Array<{ id: string; values: Omit<NormalizedVariant, 'id'> }>;
  inserts: Array<Omit<NormalizedVariant, 'id'>>;
  /** existing variants not in the new list: switched off, never deleted */
  deactivateIds: string[];
}

/**
 * Match the new list against what the product has today:
 *   1. by id (must already belong to this product)
 *   2. else by the same option combination (re-uses and re-activates the row)
 *   3. else a new row
 * Existing rows left over are switched off.
 */
export function planVariantSync(
  existing: ExistingVariant[],
  variants: NormalizedVariant[],
): { ok: true; plan: VariantSyncPlan } | { ok: false; error: OptionsError } {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const byCombo = new Map<string, ExistingVariant>();
  for (const e of existing) {
    if (e.option1 === null && e.option2 === null && e.option3 === null) continue; // label-only rows never match by combo
    const k = comboKey(e);
    // prefer an active row when two share a combination
    if (!byCombo.has(k) || (e.isActive && !byCombo.get(k)!.isActive)) byCombo.set(k, e);
  }

  const used = new Set<string>();
  const plan: VariantSyncPlan = { updates: [], inserts: [], deactivateIds: [] };

  // Pass 1: rows the client named by id claim their row first, so a new
  // variation can't take that row by matching its option combination.
  for (const v of variants) {
    if (!v.id) continue;
    const target = byId.get(v.id);
    if (!target) return { ok: false, error: { code: 'INVALID_VARIANT_ID', message: 'A variation in the list does not belong to this product' } };
    used.add(target.id);
  }
  // Pass 2: build the plan in list order.
  for (const v of variants) {
    const { id, ...values } = v;
    if (id) {
      plan.updates.push({ id, values });
      continue;
    }
    const candidate = byCombo.get(comboKey(v));
    if (candidate && !used.has(candidate.id)) {
      used.add(candidate.id);
      plan.updates.push({ id: candidate.id, values });
    } else {
      plan.inserts.push(values);
    }
  }

  for (const e of existing) {
    if (!used.has(e.id) && e.isActive !== false) plan.deactivateIds.push(e.id);
  }
  return { ok: true, plan };
}

/**
 * What every client sees for a variant. priceCents is always a number (the
 * variant's own price, else the product's), so app versions that read
 * priceCents as a number keep working. hasOwnPrice tells the editor which.
 */
export function withEffectivePrice<T extends { priceCents: number | null }>(
  v: T,
  productPriceCents: number,
): T & { priceCents: number; hasOwnPrice: boolean } {
  return { ...v, priceCents: v.priceCents ?? productPriceCents, hasOwnPrice: v.priceCents !== null };
}
