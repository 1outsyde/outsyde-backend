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
import { getUncachableStripeClient } from "../stripe/stripeClient";

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
    // A default card the customer picked stays, unless Stripe kept it for one payment only ("limited").
    if (chosen || older || (pm.id === o.defaultId && mark !== "limited")) kept.push({ pm, older: !chosen });
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
  return Array.from(byCard.values()).sort((a, b) => order(a) - order(b) || b.pm.created - a.pm.created);
}

/** How far back the Save switch lookup goes: older builds refresh the list right after saving. */
const SAVE_SWITCH_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

/**
 * Pure: unmarked, non wallet cards saved after `start` and in the last 7 days, the only ones that can
 * still be a fresh Save switch card. Cards left by vendor site bookings stay unmarked forever; without the
 * window every list read for those customers would pay a second Stripe call.
 */
export function cardsToCheckForSaveSwitch(pms: Stripe.PaymentMethod[], o: { start: number; now: number }): Stripe.PaymentMethod[] {
  const since = Math.max(o.start, o.now - SAVE_SWITCH_LOOKBACK_SECONDS);
  return pms.filter((p) => (p.allow_redisplay ?? "unspecified") === "unspecified" && p.created >= since && !!p.card && !p.card.wallet);
}

/**
 * The cards to show for a Stripe customer. Cards saved after SAVED_CARD_RULES_START through the shop's
 * Save switch (our SetupIntent, any app build) count as chosen and are promoted to "always" here,
 * best effort. A Stripe error on that lookup only hides those new unmarked cards; it never fails the list.
 */
export async function listShownCards(customerId: string, defaultId: string | null): Promise<ShownCard[]> {
  const stripe = await getUncachableStripeClient();
  const listed = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 100 });
  const pms = listed.data;

  const chosenIds = new Set<string>();
  const unmarkedNew = cardsToCheckForSaveSwitch(pms, { start: SAVED_CARD_RULES_START, now: Math.floor(Date.now() / 1000) });
  if (unmarkedNew.length) {
    try {
      const sis = await stripe.setupIntents.list({ customer: customerId, limit: 100 });
      const fromSwitch = new Set(
        sis.data
          .filter((si) => si.status === "succeeded" && si.metadata?.outsyde_saved_card === SAVED_CARD_SETUP_METADATA.outsyde_saved_card)
          .map((si) => (typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id))
          .filter((id): id is string => !!id),
      );
      const promote = unmarkedNew.filter((p) => fromSwitch.has(p.id));
      for (const p of promote) chosenIds.add(p.id);
      await Promise.all(promote.map((p) =>
        stripe.paymentMethods.update(p.id, { allow_redisplay: "always" }).catch((e: unknown) =>
          console.error(`[SavedCards] could not mark ${p.id} as saved:`, e instanceof Error ? e.message : "unknown error"))));
    } catch (e) {
      console.error(`[SavedCards] could not read setup intents for ${customerId}:`, e instanceof Error ? e.message : "unknown error");
    }
  }
  return pickShownCards(pms, { defaultId, chosenIds, start: SAVED_CARD_RULES_START });
}

/**
 * Extra fields for a booking or ticket payment the app opens in Stripe's payment sheet: a CustomerSession
 * for the PaymentIntent's own customer, so the sheet shows the customer's chosen cards, a Save box (off by
 * default) and Apple Pay. Only when the caller asked (`paymentSheet: true`); {} otherwise, with no
 * customer, or on any Stripe error, so the payment itself never fails over it.
 */
export async function paymentSheetFields(
  customer: string | { id: string } | null | undefined,
  wanted: boolean,
): Promise<{ customerId?: string; customerSessionClientSecret?: string }> {
  const customerId = typeof customer === "string" ? customer : customer?.id;
  if (!wanted || !customerId) return {};
  try {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.customerSessions.create({
      customer: customerId,
      components: {
        mobile_payment_element: {
          enabled: true,
          features: {
            payment_method_save: "enabled",
            payment_method_redisplay: "enabled",
            payment_method_remove: "disabled",
            payment_method_allow_redisplay_filters: ["always"],
          },
        },
      },
    });
    return { customerId, customerSessionClientSecret: session.client_secret };
  } catch (e) {
    console.error(`[SavedCards] could not start a payment sheet session for ${customerId}:`, e instanceof Error ? e.message : "unknown error");
    return {};
  }
}
