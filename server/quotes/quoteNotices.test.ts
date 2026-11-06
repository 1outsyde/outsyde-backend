/**
 * Quotes step 6a: the words and the "needs you" list for extras and the other quote moments (pure, no database).
 * Legend 2026-11-05 (step 6 calls 2 to 6, all as recommended). Run with: npx tsx server/quotes/quoteNotices.test.ts
 */
import {
  extraPushText, buildExtraEmail, extraActivityText, businessNotice, quoteActionsFor, pushPreview, PUSH_BODY_MAX,
  type QuoteDetail,
} from "./quoteNoticesRules";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const noDashes = (s: string) => !/[—–]| - /.test(s);
const noRate = (s: string) => !/%/.test(s);

console.log("\n── the extra's push (call 2) ──");
{
  const t = extraPushText({ description: "2 extra hours", totalCents: 10800 });
  assert(t === "Needs your OK: 2 extra hours, $108.00 with the service fee. Nothing is charged unless you approve.", "the words from the mockup", t);
  assert(noDashes(t) && noRate(t), "no dashes, no fee rate", t);
  const long = extraPushText({ description: "x".repeat(300), totalCents: 500 });
  assert(pushPreview(long).length === PUSH_BODY_MAX && pushPreview(long).endsWith("..."), "a long one is cut with an ellipsis", pushPreview(long).length);
  assert(pushPreview("  a   b  ") === "a b", "spaces tidied");
  assert(PUSH_BODY_MAX > 50, "longer than a normal message preview (50)", PUSH_BODY_MAX);
}

console.log("\n── the extra's Activity row (call 4) ──");
{
  const a = extraActivityText({ businessName: "Royal Elite Moving", title: "2 Bedroom Move", description: "2 extra hours", totalCents: 10800 });
  assert(a.title === "Royal Elite Moving", "titled with the business", a);
  assert(a.message === "Added 2 extra hours to 2 Bedroom Move. $108.00 with the service fee, only if you approve.", "what, how much, only if approved", a);
  assert(extraActivityText({ businessName: "  ", title: "Move", description: "Boxes", totalCents: 100 }).title === "The business", "no name: a fallback");
}

console.log("\n── the extra's email (call 3) ──");
{
  const e = buildExtraEmail({
    customerFirstName: "Jordan", businessName: "Royal Elite Moving", title: "2 Bedroom Move", description: "2 extra hours",
    amountCents: 10000, serviceFeeCents: 800, totalBeforeCents: 65000, link: "https://goutsyde.com/q/abc12345",
  });
  assert(e.subject === "Royal Elite Moving needs your OK for 2 extra hours", "subject", e.subject);
  for (const want of ["Hi Jordan,", "2 extra hours", "$100.00", "$8.00", "$108.00", "$750.00", "$650.00", "Nothing is charged unless you approve", "https://goutsyde.com/q/abc12345"]) {
    assert(e.text.includes(want) && e.html.includes(want), `text and html have ${want}`);
  }
  assert(e.html.includes("Review and approve"), "the button");
  assert(noDashes(e.text) && noDashes(e.subject) && noRate(e.text) && noRate(e.html.replace(/<[^>]+>/g, "")), "no dashes, no fee rate", e.text);
  const x = buildExtraEmail({ customerFirstName: null, businessName: "<b>Evil</b>", title: "Move & <i>more</i>", description: "<script>x</script>", amountCents: 100, serviceFeeCents: 8, totalBeforeCents: 1000, link: "https://goutsyde.com/q/abc12345" });
  assert(!x.html.includes("<script>") && !x.html.includes("<b>Evil") && x.html.includes("&lt;script&gt;"), "everything the business typed is escaped", x.html.slice(0, 300));
  assert(x.text.startsWith("Hi,"), "no first name: Hi,");
}

console.log("\n── business Activity (call 6) ──");
{
  const b = (k: Parameters<typeof businessNotice>[0]) => businessNotice(k, { customerName: "Jordan M.", title: "2 Bedroom Move", description: "2 extra hours", amountCents: 10000 });
  assert(b("paid").title === "Quote paid" && b("paid").message === "Jordan M. paid for 2 Bedroom Move. It's booked.", "paid", b("paid"));
  assert(b("extra_approved").message === "Jordan M. approved 2 extra hours, $100.00.", "approved", b("extra_approved"));
  assert(b("extra_declined").message === "Jordan M. declined 2 extra hours. Nothing was added.", "declined", b("extra_declined"));
  assert(b("problem_reported").message === "Jordan M. reported a problem with 2 Bedroom Move. Your payout for this job is paused while Outsyde reviews it.", "report", b("problem_reported"));
  assert(b("card_failed").message === "We couldn't hold Jordan M.'s card for 2 Bedroom Move, $100.00. We asked them to update it.", "card failed", b("card_failed"));
  for (const k of ["paid", "extra_approved", "extra_declined", "problem_reported", "card_failed"] as const) {
    assert(noDashes(b(k).message) && noRate(b(k).message) && b(k).type.startsWith("quote_") && !b(k).type.startsWith("subscription_"), `${k}: copy rules and a quote_ type`, b(k));
  }
  assert(b("card_failed").push === true && b("paid").push === false && b("extra_approved").push === false && b("problem_reported").push === false,
    "a push only where no chat card already pushed them (card failed)");
  assert(businessNotice("paid", { customerName: "", title: "Move", amountCents: 0 }).message.startsWith("The customer paid"), "no name: the customer");
}

console.log("\n── what needs the customer (call 5) ──");
{
  const base = (o: Partial<QuoteDetail> = {}): QuoteDetail => ({
    quote: { id: "q1", status: "paid", conversationId: "c1", businessName: "Royal Elite Moving", title: "2 Bedroom Move" },
    balance: null, window: null, extras: [], extrasPayment: null, ...o,
  });
  assert(quoteActionsFor([base()]).length === 0, "nothing open: nothing");
  const ex = { id: "x1", description: "2 extra hours", amountCents: 10000, serviceFeeCents: 800, totalCents: 10800, status: "proposed", canApprove: true, createdAt: "2026-11-13T18:00:00Z" };
  let a = quoteActionsFor([base({ extras: [ex, { ...ex, id: "x2", status: "approved", canApprove: false }] })]);
  assert(a.length === 1 && a[0].kind === "approve_extra" && a[0].extraId === "x1" && a[0].totalCents === 10800 && a[0].quoteId === "q1" && a[0].conversationId === "c1" && a[0].businessName === "Royal Elite Moving", "an extra to approve", a);
  a = quoteActionsFor([base({ balance: { needsNewCard: true, holdCents: 59400 } })]);
  assert(a.length === 1 && a[0].kind === "update_card" && a[0].amountCents === 59400, "the balance needs a new card", a);
  a = quoteActionsFor([base({ extrasPayment: { needsNewCard: true, unpaid: false, holdCents: 10800 } })]);
  assert(a.length === 1 && a[0].kind === "update_extras_card" && a[0].amountCents === 10800, "the extras need a new card", a);
  a = quoteActionsFor([base({ extrasPayment: { needsNewCard: false, unpaid: true, holdCents: 10800 } })]);
  assert(a.length === 1 && a[0].kind === "pay_extras" && a[0].amountCents === 10800, "pay for extras", a);
  a = quoteActionsFor([base({ window: { canConfirm: true, canReport: true, endsAt: "2026-11-13T23:00:00Z" } })]);
  assert(a.length === 1 && a[0].kind === "confirm_or_report" && a[0].endsAt === "2026-11-13T23:00:00Z", "confirm or report", a);
  a = quoteActionsFor([base({ window: { canConfirm: false, canReport: false, endsAt: "x" } })]);
  assert(a.length === 0, "a closed window: nothing", a);
  a = quoteActionsFor([base({ quote: { id: "q2", status: "sent", conversationId: "c", businessName: "B", title: "T" }, extras: [ex] })]);
  assert(a.length === 0, "only paid quotes", a);
  a = quoteActionsFor([
    base({ window: { canConfirm: true, canReport: true, endsAt: "2026-11-13T23:00:00Z" } }),
    base({ quote: { id: "q3", status: "paid", conversationId: "c3", businessName: "B", title: "T" }, extras: [ex] }),
    base({ quote: { id: "q4", status: "paid", conversationId: "c4", businessName: "B", title: "T" }, balance: { needsNewCard: true, holdCents: 1 } }),
  ]);
  assert(a.map((x) => x.kind).join(",") === "update_card,approve_extra,confirm_or_report", "money first: cards, then extras, then confirm", a.map((x) => x.kind));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
