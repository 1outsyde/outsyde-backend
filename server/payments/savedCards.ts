/**
 * Saved cards: which of a customer's Stripe cards the apps may show again (p4-applepay step 1).
 *
 * Stripe marks each saved card with `allow_redisplay`:
 *  - "always": the customer chose to save it (Save switch or Save box). Shown.
 *  - "limited": kept only for the payment it came from (a booking's cancellation fee). Never shown.
 *  - "unspecified": no mark. Cards saved before SAVED_CARD_RULES_START are the customer's older cards and
 *    stay available, tucked away; ones saved later came from a flow with no Save choice and are hidden.
 * Wallet cards (Apple Pay, Google Pay) are never shown: Apple's terms forbid reusing a saved Apple Pay
 * card for an on session payment.
 */
import type Stripe from "stripe";

/** 2026-10-29 00:00 America/New_York. Unmarked cards created before this are "older" cards. */
export const SAVED_CARD_RULES_START = 1793246400;

/** Metadata on SetupIntents made by POST /api/me/payment-methods/setup-intent (the shop's Save switch). */
export const SAVED_CARD_SETUP_METADATA = { outsyde_saved_card: "1" } as const;

export interface ShownCard {
  pm: Stripe.PaymentMethod;
  /** true for an older unmarked card (shown under "Other saved cards" only). */
  older: boolean;
}

/** Pure: the cards to show, one per physical card, default first, then chosen newest, then older newest. */
export function pickShownCards(
  pms: Stripe.PaymentMethod[],
  o: { defaultId: string | null; chosenIds: Set<string>; start: number },
): ShownCard[] {
  const kept: ShownCard[] = [];
  for (const pm of pms) {
    if (!pm.card || pm.card.wallet) continue;
    const mark = pm.allow_redisplay ?? "unspecified";
    const chosen = mark === "always" || o.chosenIds.has(pm.id);
    const older = !chosen && mark === "unspecified" && pm.created < o.start;
    if (chosen || older || pm.id === o.defaultId) kept.push({ pm, older: !chosen });
  }

  // Best first: chosen, then the default, then newest.
  const rank = (c: ShownCard) => [c.older ? 1 : 0, c.pm.id === o.defaultId ? 0 : 1, -c.pm.created];
  const better = (a: ShownCard, b: ShownCard) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i];
    return false;
  };
  const byCard = new Map<string, ShownCard>();
  for (const c of kept) {
    const key = c.pm.card?.fingerprint ? `fp:${c.pm.card.fingerprint}` : `id:${c.pm.id}`;
    const cur = byCard.get(key);
    if (!cur || better(c, cur)) byCard.set(key, c);
  }

  const order = (c: ShownCard) => (c.pm.id === o.defaultId ? 0 : c.older ? 2 : 1);
  return [...byCard.values()].sort((a, b) => order(a) - order(b) || b.pm.created - a.pm.created);
}
