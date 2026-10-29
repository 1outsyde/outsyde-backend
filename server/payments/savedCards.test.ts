/**
 * Saved card rules (p4-applepay step 1). Pure: no database, no Stripe.
 * Run with: npx tsx server/payments/savedCards.test.ts
 *
 * Mutation checks (run 2026-10-28):
 *  - drop the wallet filter → "drops Apple Pay wallet cards" and "drops wallet default" fail.
 *  - keep `limited` cards → "drops limited" fails.
 *  - compare `created <= start` instead of `<` → "drops unspecified at start" fails.
 *  - prefer newest over chosen when merging → "merges same fingerprint preferring chosen" and
 *    "merges duplicates keeping the default" fail.
 */
import type Stripe from "stripe";
import { pickShownCards } from "./savedCards";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const START = 1_800_000_000;
type Opts = { created?: number; redisplay?: "always" | "limited" | "unspecified" | null; fingerprint?: string | null; wallet?: string | null };
function pm(id: string, o: Opts = {}): Stripe.PaymentMethod {
  return {
    id,
    object: "payment_method",
    type: "card",
    created: o.created ?? START + 100,
    allow_redisplay: o.redisplay === null ? undefined : (o.redisplay ?? "always"),
    card: {
      brand: "visa",
      last4: "4242",
      exp_month: 8,
      exp_year: 2030,
      fingerprint: o.fingerprint === undefined ? `fp_${id}` : o.fingerprint,
      wallet: o.wallet ? { type: o.wallet } : null,
    },
  } as unknown as Stripe.PaymentMethod;
}
const ids = (r: { pm: Stripe.PaymentMethod }[]) => r.map((x) => x.pm.id);
const run = (pms: Stripe.PaymentMethod[], o: { defaultId?: string | null; chosen?: string[] } = {}) =>
  pickShownCards(pms, { defaultId: o.defaultId ?? null, chosenIds: new Set(o.chosen ?? []), start: START });

console.log("savedCards: pickShownCards");

assert(ids(run([pm("a"), pm("ap", { wallet: "apple_pay" })])).join() === "a", "drops Apple Pay wallet cards", ids(run([pm("a"), pm("ap", { wallet: "apple_pay" })])));

assert(ids(run([pm("a", { redisplay: "always" })])).join() === "a", "keeps always");

{
  const r = run([pm("s", { redisplay: "unspecified" })], { chosen: ["s"] });
  assert(ids(r).join() === "s" && r[0].older === false, "keeps chosenIds as not older", r);
}

assert(run([pm("l", { redisplay: "limited", created: START - 500 })]).length === 0, "drops limited");

{
  const r = run([pm("o", { redisplay: "unspecified", created: START - 1 })]);
  assert(ids(r).join() === "o" && r[0].older === true, "keeps unspecified before start as older", r);
}

{
  const r = run([pm("m", { redisplay: null, created: START - 1 })]);
  assert(ids(r).join() === "m" && r[0].older === true, "treats a missing mark like unspecified", r);
}

assert(run([pm("n", { redisplay: "unspecified", created: START + 1 })]).length === 0, "drops unspecified after start");

assert(run([pm("n", { redisplay: "unspecified", created: START })]).length === 0, "drops unspecified at start");

{
  const r = run([pm("d", { redisplay: "unspecified", created: START + 9 })], { defaultId: "d" });
  assert(ids(r).join() === "d", "keeps default even if unmarked after start", r);
}

assert(run([pm("w", { wallet: "apple_pay" })], { defaultId: "w" }).length === 0, "drops wallet default");

{
  const r = run([
    pm("old", { redisplay: "unspecified", created: START - 50, fingerprint: "same" }),
    pm("chosen", { redisplay: "always", created: START - 100, fingerprint: "same" }),
    pm("newer", { redisplay: "unspecified", created: START - 10, fingerprint: "same" }),
  ]);
  assert(ids(r).join() === "chosen", "merges same fingerprint preferring chosen", ids(r));
}

{
  const r = run([
    pm("o1", { redisplay: "unspecified", created: START - 50, fingerprint: "x" }),
    pm("o2", { redisplay: "unspecified", created: START - 10, fingerprint: "x" }),
  ]);
  assert(ids(r).join() === "o2", "merges older duplicates keeping the newest", ids(r));
}

{
  const r = run([
    pm("o1", { redisplay: "unspecified", created: START - 50, fingerprint: "x" }),
    pm("o2", { redisplay: "unspecified", created: START - 10, fingerprint: "x" }),
  ], { defaultId: "o1" });
  assert(ids(r).join() === "o1", "merges duplicates keeping the default", ids(r));
}

{
  const r = run([pm("f1", { fingerprint: null }), pm("f2", { fingerprint: null })]);
  assert(ids(r).sort().join() === "f1,f2", "keeps cards without a fingerprint apart", ids(r));
}

{
  const r = run([
    pm("old1", { redisplay: "unspecified", created: START - 90 }),
    pm("c1", { redisplay: "always", created: START + 10 }),
    pm("old2", { redisplay: "unspecified", created: START - 20 }),
    pm("c2", { redisplay: "always", created: START + 50 }),
    pm("def", { redisplay: "unspecified", created: START - 300 }),
  ], { defaultId: "def" });
  assert(ids(r).join() === "def,c2,c1,old2,old1", "orders default, chosen newest, older newest", ids(r));
}

assert(run([{ ...pm("x"), card: null } as unknown as Stripe.PaymentMethod]).length === 0, "drops a payment method with no card");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
