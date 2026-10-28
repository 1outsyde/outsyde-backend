/**
 * Product add-on groups (migration 075). Pure functions only (no db, no Express)
 * so they can be tested directly: server/productAddons.test.ts.
 *
 * Model:
 *   - a product has up to MAX_GROUPS groups, e.g. "Toppings (pick up to 3)"
 *   - a group has a min and max number of picks; min > 0 makes it required
 *   - each choice adds price_cents per unit and can ask the customer for text
 *     (e.g. the name piped on a cake), limited to text_max_length characters
 *   - choices have an on/off switch only. No stock counts (decision, Oct 28).
 *
 * Checkout trusts nothing from the client except which add-on ids were picked
 * and the typed text. Prices, names and limits come from the database.
 *
 * Old app builds send no `addons` key on a cart line. Those lines are never
 * checked against required groups (decision, Oct 28: old builds must not be
 * blocked), see server/cartPricing.ts.
 */

export const MAX_GROUPS = 10;
export const MAX_ADDONS_PER_GROUP = 30;
export const MAX_SELECT = 20;
export const MAX_GROUP_NAME = 60;
export const MAX_ADDON_NAME = 80;
export const MAX_DESCRIPTION = 300;
export const MAX_TEXT_LABEL = 60;
export const MAX_TEXT_LENGTH = 200;
export const DEFAULT_TEXT_LENGTH = 40;
export const MAX_ADDON_PRICE_CENTS = 100_000; // $1,000 per unit
export const MAX_PICKS_PER_LINE = 50;

/* ---------- rows as read from the database ---------- */

export interface AddonGroupRow {
  id: string;
  productId: string;
  name: string;
  minSelect: number;
  maxSelect: number | null;
  sortOrder: number;
  isActive: boolean;
}

export interface AddonRow {
  id: string;
  groupId: string;
  productId: string;
  name: string;
  description: string | null;
  priceCents: number;
  acceptsText: boolean;
  textLabel: string | null;
  textMaxLength: number;
  isActive: boolean;
  sortOrder: number;
}

export interface AddonGroupWithChoices extends AddonGroupRow {
  addons: AddonRow[];
}

/** Groups with their choices, ordered by sort_order then name. Inactive rows are kept. */
export function assembleGroups(groups: AddonGroupRow[], addons: AddonRow[]): AddonGroupWithChoices[] {
  const byOrder = <T extends { sortOrder: number; name: string }>(a: T, b: T) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  return [...groups].sort(byOrder).map((g) => ({
    ...g,
    addons: addons.filter((a) => a.groupId === g.id).sort(byOrder),
  }));
}

/** Only what a customer may pick: active groups, active choices, groups with at least one choice. */
export function activeGroups(groups: AddonGroupWithChoices[]): AddonGroupWithChoices[] {
  return groups
    .filter((g) => g.isActive)
    .map((g) => ({ ...g, addons: g.addons.filter((a) => a.isActive) }))
    .filter((g) => g.addons.length > 0);
}

/* ---------- vendor save: PUT /api/business/products/:id/addons ---------- */

export interface NormalizedAddon {
  id: string | null;
  name: string;
  description: string | null;
  priceCents: number;
  acceptsText: boolean;
  textLabel: string | null;
  textMaxLength: number;
  isActive: boolean;
  sortOrder: number;
}

export interface NormalizedGroup {
  id: string | null;
  name: string;
  minSelect: number;
  maxSelect: number | null;
  isActive: boolean;
  sortOrder: number;
  addons: NormalizedAddon[];
}

export type AddonsPayloadError = { code: 'INVALID_ADDONS' | 'INVALID_ADDON_ID'; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const optId = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 36 ? v : null);

/** Trims and removes control characters (line breaks included) from text the customer or vendor typed. */
export function cleanText(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function validateAddonGroupsPayload(
  body: unknown,
): { ok: true; groups: NormalizedGroup[] } | { ok: false; error: AddonsPayloadError } {
  const fail = (message: string) => ({ ok: false as const, error: { code: 'INVALID_ADDONS' as const, message } });
  if (!isObj(body) || !Array.isArray(body.groups)) return fail('Send { groups: [...] }');
  if (body.groups.length > MAX_GROUPS) return fail(`A product can have up to ${MAX_GROUPS} add-on groups`);

  const groups: NormalizedGroup[] = [];
  const seenIds = new Set<string>();
  for (const [gi, g] of body.groups.entries()) {
    if (!isObj(g)) return fail('Each group must be an object');
    const name = typeof g.name === 'string' ? cleanText(g.name) : '';
    if (!name) return fail('Every add-on group needs a name');
    if (name.length > MAX_GROUP_NAME) return fail(`Group names can be up to ${MAX_GROUP_NAME} characters`);

    const minSelect = g.minSelect === undefined || g.minSelect === null ? 0 : g.minSelect;
    const maxSelect = g.maxSelect === undefined ? null : g.maxSelect;
    if (!isInt(minSelect) || minSelect < 0 || minSelect > MAX_SELECT) return fail(`${name}: the minimum must be 0 to ${MAX_SELECT}`);
    if (maxSelect !== null && (!isInt(maxSelect) || maxSelect < 1 || maxSelect > MAX_SELECT)) {
      return fail(`${name}: the maximum must be 1 to ${MAX_SELECT}, or no limit`);
    }
    if (maxSelect !== null && maxSelect < minSelect) return fail(`${name}: the maximum can't be less than the minimum`);
    if (g.isActive !== undefined && typeof g.isActive !== 'boolean') return fail(`${name}: isActive must be true or false`);

    if (!Array.isArray(g.addons) || g.addons.length === 0) return fail(`${name}: add at least one choice`);
    if (g.addons.length > MAX_ADDONS_PER_GROUP) return fail(`${name}: up to ${MAX_ADDONS_PER_GROUP} choices per group`);

    const addons: NormalizedAddon[] = [];
    const names = new Set<string>();
    for (const [ai, a] of g.addons.entries()) {
      if (!isObj(a)) return fail(`${name}: each choice must be an object`);
      const aName = typeof a.name === 'string' ? cleanText(a.name) : '';
      if (!aName) return fail(`${name}: every choice needs a name`);
      if (aName.length > MAX_ADDON_NAME) return fail(`${name}: choice names can be up to ${MAX_ADDON_NAME} characters`);
      if (names.has(aName.toLowerCase())) return fail(`${name}: "${aName}" is listed twice`);
      names.add(aName.toLowerCase());

      const priceCents = a.priceCents ?? 0;
      if (!isInt(priceCents) || priceCents < 0 || priceCents > MAX_ADDON_PRICE_CENTS) {
        return fail(`${aName}: the price must be $0 to $${MAX_ADDON_PRICE_CENTS / 100}`);
      }
      let description: string | null = null;
      if (a.description !== undefined && a.description !== null) {
        if (typeof a.description !== 'string') return fail(`${aName}: description must be text`);
        description = a.description.trim() || null;
        if (description && description.length > MAX_DESCRIPTION) return fail(`${aName}: descriptions can be up to ${MAX_DESCRIPTION} characters`);
      }
      if (a.acceptsText !== undefined && typeof a.acceptsText !== 'boolean') return fail(`${aName}: acceptsText must be true or false`);
      const acceptsText = a.acceptsText === true;
      let textLabel: string | null = null;
      let textMaxLength = DEFAULT_TEXT_LENGTH;
      if (acceptsText) {
        if (a.textLabel !== undefined && a.textLabel !== null) {
          if (typeof a.textLabel !== 'string') return fail(`${aName}: the text label must be text`);
          textLabel = cleanText(a.textLabel) || null;
          if (textLabel && textLabel.length > MAX_TEXT_LABEL) return fail(`${aName}: the text label can be up to ${MAX_TEXT_LABEL} characters`);
        }
        if (a.textMaxLength !== undefined && a.textMaxLength !== null) {
          if (!isInt(a.textMaxLength) || a.textMaxLength < 1 || a.textMaxLength > MAX_TEXT_LENGTH) {
            return fail(`${aName}: the text limit must be 1 to ${MAX_TEXT_LENGTH} characters`);
          }
          textMaxLength = a.textMaxLength;
        }
      }
      if (a.isActive !== undefined && typeof a.isActive !== 'boolean') return fail(`${aName}: isActive must be true or false`);

      const id = optId(a.id);
      if (a.id !== undefined && a.id !== null && !id) return fail(`${aName}: invalid id`);
      if (id) {
        if (seenIds.has(id)) return fail(`${aName}: the same id is used twice`);
        seenIds.add(id);
      }
      addons.push({ id, name: aName, description, priceCents, acceptsText, textLabel, textMaxLength, isActive: a.isActive !== false, sortOrder: ai });
    }

    const isActive = g.isActive !== false;
    const onCount = addons.filter((a) => a.isActive).length;
    if (isActive && minSelect > onCount) {
      return fail(`${name}: customers must pick at least ${minSelect}, but only ${onCount} ${onCount === 1 ? 'choice is' : 'choices are'} on`);
    }

    const id = optId(g.id);
    if (g.id !== undefined && g.id !== null && !id) return fail(`${name}: invalid id`);
    if (id) {
      if (seenIds.has(id)) return fail(`${name}: the same id is used twice`);
      seenIds.add(id);
    }
    groups.push({ id, name, minSelect, maxSelect, isActive, sortOrder: gi, addons });
  }
  return { ok: true, groups };
}

/**
 * Checks that every id the vendor sent already belongs to this product:
 * a group id must be one of its groups, a choice id one of that group's choices.
 */
export function checkPayloadIds(
  groups: NormalizedGroup[],
  existing: AddonGroupWithChoices[],
): AddonsPayloadError | null {
  const byId = new Map(existing.map((g) => [g.id, g]));
  for (const g of groups) {
    const prev = g.id ? byId.get(g.id) : undefined;
    if (g.id && !prev) return { code: 'INVALID_ADDON_ID', message: `${g.name} was not found on this product. Reload and try again.` };
    for (const a of g.addons) {
      if (!a.id) continue;
      if (!prev || !prev.addons.some((x) => x.id === a.id)) {
        return { code: 'INVALID_ADDON_ID', message: `${a.name} was not found in ${g.name}. Reload and try again.` };
      }
    }
  }
  return null;
}

/* ---------- public product response ---------- */

export interface PublicAddon {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  acceptsText: boolean;
  textLabel: string | null;
  textMaxLength: number;
}
export interface PublicAddonGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number | null;
  required: boolean;
  addons: PublicAddon[];
}

export function toPublicGroups(groups: AddonGroupWithChoices[]): PublicAddonGroup[] {
  return activeGroups(groups).map((g) => ({
    id: g.id,
    name: g.name,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    required: g.minSelect > 0,
    addons: g.addons.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      priceCents: a.priceCents,
      acceptsText: a.acceptsText,
      textLabel: a.acceptsText ? a.textLabel : null,
      textMaxLength: a.textMaxLength,
    })),
  }));
}

export interface AddonSummary {
  groupCount: number;
  hasRequired: boolean;
}

/** For product lists: null when the product has nothing a customer can pick. */
export function summarizeAddons(groups: AddonGroupWithChoices[]): AddonSummary | null {
  const active = activeGroups(groups);
  if (active.length === 0) return null;
  return { groupCount: active.length, hasRequired: active.some((g) => g.minSelect > 0) };
}

/* ---------- checkout ---------- */

export interface PricedAddon {
  addonId: string;
  groupName: string;
  name: string;
  priceCents: number;
  text?: string;
}

export type AddonCheckoutError = {
  code: 'INVALID_ADDON' | 'ADDON_LIMIT' | 'ADDON_REQUIRED' | 'ADDON_TEXT_REQUIRED' | 'ADDON_TEXT_TOO_LONG';
  message: string;
};

/**
 * Prices a cart line's picks against the product's groups (as stored, active or not).
 * `picks` is whatever the client sent as line.addons; only called when that key is present.
 */
export function priceLineAddons(
  groups: AddonGroupWithChoices[],
  picks: unknown,
  productName: string,
): { ok: true; addons: PricedAddon[]; perUnitCents: number } | { ok: false; error: AddonCheckoutError } {
  const bad = (code: AddonCheckoutError['code'], message: string) => ({ ok: false as const, error: { code, message } });
  if (!Array.isArray(picks)) return bad('INVALID_ADDON', `The add-ons for ${productName} could not be read. Try again.`);
  if (picks.length > MAX_PICKS_PER_LINE) return bad('INVALID_ADDON', `Too many add-ons picked for ${productName}`);

  const active = activeGroups(groups);
  const lookup = new Map<string, { group: AddonGroupWithChoices; addon: AddonRow }>();
  for (const g of active) for (const a of g.addons) lookup.set(a.id, { group: g, addon: a });

  const chosen = new Map<string, { group: AddonGroupWithChoices; addon: AddonRow; text?: string }>();
  for (const p of picks) {
    const addonId = isObj(p) && typeof p.addonId === 'string' ? p.addonId : null;
    const hit = addonId ? lookup.get(addonId) : undefined;
    if (!addonId || !hit) return bad('INVALID_ADDON', `An add-on picked for ${productName} is no longer available`);
    if (chosen.has(addonId)) return bad('INVALID_ADDON', `${hit.addon.name} was picked twice for ${productName}`);

    let text: string | undefined;
    if (hit.addon.acceptsText) {
      const raw = isObj(p) && typeof p.text === 'string' ? cleanText(p.text) : '';
      const what = hit.addon.textLabel || hit.addon.name;
      if (!raw) return bad('ADDON_TEXT_REQUIRED', `Fill in "${what}" for ${productName}`);
      if ([...raw].length > hit.addon.textMaxLength) {
        return bad('ADDON_TEXT_TOO_LONG', `"${what}" can be up to ${hit.addon.textMaxLength} characters`);
      }
      text = raw;
    }
    chosen.set(addonId, { ...hit, text });
  }

  for (const g of active) {
    const count = [...chosen.values()].filter((c) => c.group.id === g.id).length;
    if (g.maxSelect !== null && count > g.maxSelect) {
      return bad('ADDON_LIMIT', `${g.name}: pick up to ${g.maxSelect} for ${productName}`);
    }
    if (count < g.minSelect) {
      return bad('ADDON_REQUIRED', g.minSelect === 1
        ? `${g.name}: pick one for ${productName}`
        : `${g.name}: pick at least ${g.minSelect} for ${productName}`);
    }
  }

  // Stable order: group order, then choice order, whatever order the client sent.
  const addons: PricedAddon[] = [];
  for (const g of active) {
    for (const a of g.addons) {
      const c = chosen.get(a.id);
      if (!c) continue;
      addons.push({ addonId: a.id, groupName: g.name, name: a.name, priceCents: a.priceCents, ...(c.text !== undefined ? { text: c.text } : {}) });
    }
  }
  return { ok: true, addons, perUnitCents: addons.reduce((s, a) => s + a.priceCents, 0) };
}

/* ---------- labels for orders and emails (plain text: escape when rendering HTML) ---------- */

/** e.g. `Sprinkles, Name frosting: "Happy 5th Mia"` */
export function addonsLabel(addons: PricedAddon[]): string {
  return addons.map((a) => (a.text !== undefined ? `${a.name}: "${a.text}"` : a.name)).join(', ');
}

/** Variant and add-ons on one line for emails, e.g. `Pink · Sprinkles, Cake topper`. */
export function orderItemDetail(item: { variantLabel?: string | null; addonsLabel?: string | null }): string | undefined {
  const parts = [item.variantLabel, item.addonsLabel].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
