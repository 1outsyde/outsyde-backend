/**
 * Pure tests for the account setup emails: copy, framing, house style and the Resend payload.
 * Run with: npx tsx server/accountSetup/emails.test.ts   (no database; network is stubbed)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.FRONTEND_URL = "https://www.goutsyde.com";
process.env.API_BASE_URL = "https://api.example.test";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

/** Visible words only: tags, entities and URLs removed. */
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/https?:\/\/\S+/g, " ");
}
function noDashes(s: string): boolean {
  return !/[-‒–—―]/.test(s.replace(/https?:\/\/\S+/g, " "));
}

(async () => {
  const E = await import("./emails");
  type Step = { key: "plan" | "payouts" | "username"; label: string; done: boolean };
  const S = (key: Step["key"], done: boolean): Step => ({
    key, done, label: { plan: "Choose your plan", payouts: "Connect payouts with Stripe", username: "Pick your username" }[key],
  });
  const base = { to: "a@x.test", userId: "user-1", displayName: "Studio <b>X</b>" };

  // ── framing ──
  {
    const f = E.stepsLeftFraming("photographer", ["payouts", "username"], false);
    assert(f.subject === "Two steps from your first Outsyde booking", "photographer, 2 open: subject counts steps", f.subject);
    assert(f.heading === "You're almost bookable." && f.finishButton === "Get bookable", "photographer heading + main button", f);
    const one = E.stepsLeftFraming("photographer", ["payouts"], false);
    assert(one.subject === "One step from your first Outsyde booking", "photographer, 1 open: 'One step'", one.subject);
    const biz = E.stepsLeftFraming("business", ["plan", "payouts"], false);
    assert(biz.subject === "Your Outsyde page is almost live" && biz.finishButton === "Finish and go live", "business framing", biz);
    const review = E.stepsLeftFraming("business", ["username"], true);
    assert(review.heading === "You're in review." && review.subheading === "Grab your username while you wait.", "business awaiting approval → review framing", review);
    const staff = E.stepsLeftFraming("staff", ["payouts", "username"], false);
    assert(staff.subject === "Get paid for your appointments" && staff.heading === "Let's get your payouts set.", "staff framing", staff);
    for (const role of ["consumer", "staff", "photographer", "business"] as const) {
      const u = E.stepsLeftFraming(role, ["username"], false);
      assert(u.subject === "Claim your name on Outsyde" && u.heading === "One step left.", `${role}, only username open → username framing`, u);
    }
  }

  // ── step copy ──
  {
    assert(E.stepCopy("payouts", "photographer")!.button === "Start getting paid", "photographer payouts button");
    assert(E.stepCopy("payouts", "business")!.button === "Turn on payments", "business payouts button");
    assert(E.stepCopy("payouts", "staff")!.button === "Connect payouts", "staff payouts button");
    assert(E.stepCopy("plan", "business")!.button === "Go live", "plan button");
    assert(E.stepCopy("username", "consumer")!.button === "Claim my username", "username button");
    assert(E.stepCopy("password", "consumer") === null && E.stepCopy("approval", "business") === null, "password and approval have no block");
  }

  // ── rendered emails ──
  const cases: { name: string; params: Parameters<typeof E.renderStepsLeftEmail>[0]; hooks: string[]; mainButton: string | null }[] = [
    { name: "photographer payouts + username", params: { ...base, role: "photographer", steps: [S("payouts", false), S("username", false)] },
      hooks: ["Get paid for every shoot", "Claim your name"], mainButton: "Get bookable" },
    { name: "photographer payouts only", params: { ...base, role: "photographer", steps: [S("payouts", false), S("username", true)] },
      hooks: ["Get paid for every shoot"], mainButton: null },
    { name: "business plan + payouts, username done", params: { ...base, role: "business", steps: [S("plan", false), S("payouts", false), S("username", true)] },
      hooks: ["You&#39;re approved. Time to go live.", "Your customers are ready to pay"], mainButton: "Finish and go live" },
    { name: "business in review, username open", params: { ...base, role: "business", steps: [S("username", false)], awaitingApproval: true },
      hooks: ["Claim your name"], mainButton: null },
    { name: "staff payouts + username", params: { ...base, role: "staff", steps: [S("payouts", false), S("username", false)] },
      hooks: ["Get paid for your appointments", "Claim your name"], mainButton: "Finish setup" },
    { name: "consumer username", params: { ...base, role: "consumer", steps: [S("username", false)] },
      hooks: ["Claim your name"], mainButton: null },
  ];

  for (const c of cases) {
    const m = E.renderStepsLeftEmail(c.params);
    const blocks = (m.html.match(/border-left:3px solid #E8B930/g) || []).length;
    assert(blocks === c.hooks.length, `${c.name}: ${c.hooks.length} step block(s)`, blocks);
    assert(c.hooks.every((h) => m.html.includes(h)), `${c.name}: hooks present`, c.hooks);
    const hasMain = c.mainButton ? m.html.includes(`>${c.mainButton}</a>`) && (m.html.match(/padding:14px 36px/g) || []).length === 1 : !m.html.includes("padding:14px 36px");
    assert(hasMain, `${c.name}: main button ${c.mainButton ?? "hidden (single step)"}`);
    assert(m.html.includes('href="https://www.goutsyde.com/finish"'), `${c.name}: buttons go to /finish`);
    assert(m.html.includes("/api/account-setup/unsubscribe?u=user-1&s="), `${c.name}: unsubscribe link`);
    assert(m.text.includes("https://www.goutsyde.com/finish") && m.text.includes("Stop these reminders: "), `${c.name}: plain text has links`);
    assert(noDashes(m.subject) && noDashes(visibleText(m.html)) && noDashes(m.text), `${c.name}: no dashes anywhere in the copy`,
      { subject: m.subject, text: m.text });
    assert(!m.html.includes("<b>X</b>"), `${c.name}: no unescaped name in html`);
  }
  {
    const m = E.renderStepsLeftEmail(cases[2].params);
    assert(m.html.includes("Already done") && m.html.includes("Pick your username"), "done steps listed under 'Already done'");
    const order = m.html.indexOf("Time to go live") < m.html.indexOf("ready to pay");
    assert(order, "blocks follow checklist order (plan before payouts)");
  }

  // ── claim email ──
  {
    const m = E.renderClaimReminderEmail({ to: "a@x.test", userId: "user-1", firstName: "Adia", claimUrl: "https://www.goutsyde.com/claim?token=t&email=a%40x.test", hasUsername: false });
    assert(m.subject === "Adia, your Outsyde account is ready to claim", "claim subject unchanged", m.subject);
    assert(m.html.includes("Name, email and phone saved") && !m.html.includes("—"), "claim checklist has no dash");
    assert(noDashes(visibleText(m.html)) && noDashes(m.text), "claim email copy has no dashes", m.text);
    assert(m.html.includes("https://www.goutsyde.com/claim?token=t&email=a%40x.test"), "claim button keeps its link");
  }

  // ── Resend payload (network stubbed) ──
  {
    const calls: { url: string; body: any }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ id: "email_123" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    process.env.RESEND_API_KEY = "re_test";
    try {
      await E.sendStepsLeftEmail(cases[0].params);
      await E.sendClaimReminderEmail({ to: "b@x.test", userId: "user-2", firstName: null, claimUrl: "https://www.goutsyde.com/claim?token=t&email=b", hasUsername: true });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.RESEND_API_KEY;
    }
    assert(calls.length === 2 && calls.every((c) => c.url.includes("api.resend.com")), "two sends went to Resend", calls.map((c) => c.url));
    assert(calls.every((c) => c.body?.reply_to === E.REPLY_TO || (Array.isArray(c.body?.reply_to) && c.body.reply_to[0] === E.REPLY_TO)), "reply to is info@goutsyde.com on both", calls.map((c) => c.body?.reply_to));
    assert(E.REPLY_TO === "info@goutsyde.com", "REPLY_TO constant");
    assert(calls.every((c) => typeof c.body?.headers?.["List-Unsubscribe"] === "string" && c.body.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click"), "List-Unsubscribe headers kept");
    assert(calls[0].body?.subject === "Two steps from your first Outsyde booking", "sent subject matches render", calls[0].body?.subject);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
