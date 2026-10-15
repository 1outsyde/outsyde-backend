# Account Setup Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every incomplete Outsyde account (no password, no username, no plan, no payouts) is guided to completion at sign-in, by email and by push, on both goutsyde.com and OutsydeCapture.

**Architecture:** One backend module (`server/accountSetup/`) owns "what is missing for this user" and is the only source for the app, the website and the reminder job. Claim (passwordless → password + username) reuses the existing 6-digit reset code and reset-token columns, so `verify-code` is unchanged. Reminders run in the existing process behind an env flag that defaults off, logged in a new table so nothing double-sends.

**Tech Stack:** Express + Drizzle + Neon (outsyde-backend), Next.js App Router BFFs (outsyde-web), Expo / React Native (OutsydeCapture), Resend, expo-server-sdk.

**Spec:** Decisions made in the Oct 14 2026 session with Legend (design canvas "Finish Your Account Flow"); summarized under Global Constraints.

**Verified at:** outsyde-backend `11735d7`, outsyde-web `efd4946`, OutsydeCapture `40fde19`, Neon `muddy-violet-59386933` (read-only).

## Global Constraints

- Vault first: the Obsidian vault is read before any build prompt is run; anything here that conflicts with a vault "Code audit" callout is re-verified on `main`.
- Each step runs AUDIT (read-only) → REGRESSION (read-only, Regression Check Protocol template) → BUILD. Prompts are labeled [Backend], [Web] or [App]. Merge via GitHub UI only, after `tsc` shows no new errors over the baseline (60 errors on `11735d7`).
- Scope for this build: outsyde-backend, outsyde-web, OutsydeCapture only (Legend, Oct 14). Vendor sites are not touched; no route they call changes (`/api/users/identity`, `/api/auth/forgot-password*`, `/api/auth/reset-password` stay byte-identical).
- All response changes are additive. Old app builds must keep working: the new login error code keeps HTTP 401 and a readable `error.message`.
- Production DB is read-only. Migration 042 is re-runnable SQL that Legend hand-runs in Neon before merge (Render's `preDeployCommand` re-runs it harmlessly).
- Reminders never send unless `ACCOUNT_SETUP_REMINDERS_ENABLED=true` on Render. Legend reviews the dry-run list first.
- Sign-in emails never auto-login. The only token in an email is the claim token for accounts with no password (7-day expiry, stored in the existing `reset_token_hash`).
- Usernames go through `validateUsername()` (lowercase, `[a-z0-9_]`, 3–30).
- Emails use the existing `wrapEmail/emailHeader/emailCta/emailFooter` shell, CAN-SPAM address, a "Stop these reminders" link and a `List-Unsubscribe` header.
- Links point at `FRONTEND_URL` (https://www.goutsyde.com). App Store link: `https://apps.apple.com/app/outsyde/id6738926870`.
- Copy matches the canvas mockups (Claim email, Steps-left email, /claim, /finish, push, app home card).

## Review Focus

1. Someone types a passwordless email and a random password five times → one code email, not five (resend only if the last code is older than 60 s), and rate limits still apply.
2. A claim token from an older reminder after a newer reminder overwrote it → /claim falls back to "send me a code" instead of a dead end.
3. A user finishes Stripe in a browser while the job runs → the job's fresh status check skips them; no "connect payouts" email after they finished.
4. Grandfathered and waived (complimentary) businesses → plan counts as done via `isSubscriptionProvisioned`; they are never told to pick a plan.
5. A username someone else takes between the availability check and submit → claim returns 409 `USERNAME_TAKEN` and keeps the password unset, so retrying works.

---

## What is missing, per role (source of truth)

| Role | Steps checked, in order | "Done" means |
|---|---|---|
| any | `password` | `users.password` set, or `apple_id`, or `google_sub` |
| any | `username` | `users.username` not null |
| business (`is_vendor`) | `approval` | `approval_status = 'approved'` (not actionable; shown as waiting, never emailed) |
| business | `plan` | `vendor_subscriptions` row exists and `isSubscriptionProvisioned(row, tier)` |
| business | `payouts` | `stripe_onboarding_complete`, after `stripeService.syncOnboardingStatus` self-heal |
| photographer | `payouts` | `photographers.stripe_onboarding_complete` (same self-heal) |
| staff (active `staff_members` row) | `payouts` | `staff_members.stripe_onboarding_complete` |

Excluded from reminders: `is_admin`, `is_active = false`, `deletion_status <> 'active'`, no email, demo businesses, rejected businesses, opted-out users.

## Files

**outsyde-backend**
- Create `migrations/042_account_setup_reminders.sql` — tables `account_setup_reminders`, `account_setup_optouts`.
- Modify `shared/schema.ts` — Drizzle tables for the two above (additive).
- Create `server/accountSetup/status.ts` — `getAccountSetupStatus(userId)`, pure `computeSetupSteps(input)`.
- Create `server/accountSetup/claim.ts` — `issueClaimCode(user)`, `issueClaimLinkToken(user)`, `isClaimable(user)`.
- Create `server/accountSetup/reminders.ts` — `planReminders(now)`, `sendDueReminders({dryRun})`, `startAccountSetupReminderJob()`.
- Create `server/accountSetup/emails.ts` — `sendClaimEmail`, `sendStepsLeftEmail`, `unsubscribeUrl(userId)`, `verifyUnsubscribeSig`.
- Create `server/routes/accountSetup.ts` — router mounted at `/api/account-setup`.
- Create `server/accountSetup/status.test.ts`, `server/accountSetup/reminders.test.ts` (pure, `npx tsx`).
- Modify `server/routes.ts` — mobile login passwordless branch (B3); `connect-return` / `connect-refresh` `return=finish` (B4); vendor + staff create-link `returnTo` (B4).
- Modify `server/Photographers/photographers.controller.ts` — Stripe return URLs (B4).
- Modify `server/storage.ts` — `createUser` writes `source` (B7).
- Modify `server/index.ts` — mount router, start job.

**outsyde-web**
- Create `app/claim/page.tsx`, `app/finish/page.tsx`, BFFs under `app/api/account-setup/`.
- Modify `app/login/page.tsx` (needs-setup hand-off), `app/api/login/route.ts` (pass `code`), `app/consumer-signup` (existing-email hand-off), `app/subscription/success/page.tsx` (continue button), `app/api/photographer/me/stripe-onboarding/route.ts` (`webRedirect`), `middleware.ts` (protect `/finish`).
- Create `public/.well-known/apple-app-site-association`.

**OutsydeCapture**
- Create `screens/ClaimAccountScreen.tsx`, `screens/FinishSetupScreen.tsx`, `components/FinishSetupCard.tsx`.
- Modify `context/AuthContext.tsx` (surface `ACCOUNT_NEEDS_SETUP`), login screen, `navigation/RootNavigator.tsx`, `context/NotificationContext.tsx` (tap routing), `services/api.ts`, `app.json` (`associatedDomains`, `applinks:www.goutsyde.com`).

---

## Backend API (Interfaces every client relies on)

- `POST /api/auth/mobile/login`, passwordless claimable account → `401 {success:false, error:{code:"ACCOUNT_NEEDS_SETUP", message:"Your account needs a password. We emailed a 6-digit code to finish setting it up.", email:"<normalized email>", firstName:"<first name or null>", hasUsername:boolean}}` and a code email sent (resend only if the previous code is >60 s old).
- `POST /api/auth/login` (session login) is NOT changed: its only caller is the web accept-invite BFF (staff invites), which always has a password.
- Existing `POST /api/auth/forgot-password/verify-code {email, code}` → `{success, resetToken}` (unchanged).
- `POST /api/account-setup/claim {email, resetToken, newPassword, username?}` → `200` same shape as mobile login success `{success, user, accessToken, refreshToken, expiresIn}`; errors: `400 INVALID_TOKEN`, `400 INVALID_PASSWORD` (<6 chars), `400 INVALID_USERNAME {reason}`, `400 USERNAME_REQUIRED` (user has none and none sent), `409 USERNAME_TAKEN`, `409 ALREADY_CLAIMED` (user already has a password).
- `POST /api/account-setup/send-code {email}` → always `200 {success:true}` (enumeration-safe; only sends to claimable accounts; same 60 s resend rule).
- `GET /api/account-setup/status` (auth) → `{role:"consumer"|"business"|"photographer"|"staff", complete:boolean, next:StepKey|null, steps:[{key:StepKey, state:"done"|"todo"|"waiting", label:string}]}` with `StepKey = "password"|"username"|"approval"|"plan"|"payouts"`.
- `POST /api/account-setup/username {username}` (auth) → sets username only if currently null; `409 USERNAME_TAKEN`, `409 ALREADY_SET`.
- `GET /api/account-setup/unsubscribe?u=<userId>&s=<sig>` → small HTML page "You won't get setup reminders anymore."
- `GET /api/admin/account-setup/preview` (platform admin) → `[{userId, email, role, steps:[...], reminderNumber, channel:["email","push"?], template:"claim"|"steps_left"}]`.
- `POST /api/admin/account-setup/send` (platform admin) `{dryRun?:boolean}` → `{sent, skipped, failed}`.
- Stripe create-link endpoints accept `returnTo:"finish"` (business, staff) and `webRedirect:true|returnTo:"finish"` (photographer). Returns then land on `FRONTEND_URL/finish?stripe=done` (or `refresh`).
- Push payload data: `{type:"account_setup", screen:"FinishSetup", step:StepKey}`.

---

### Task B1: Migration 042

**Files:** Create `migrations/042_account_setup_reminders.sql`; Modify `shared/schema.ts`.

- [ ] AUDIT [Backend]: confirm 042 is the next free number in `migrations/`, that `_schema_migrations` has no `042_*`, and that neither table exists (`to_regclass`).
- [ ] REGRESSION [Backend]: grep every repo for `account_setup_`; confirm nothing reads these names; confirm `accountDeletionService` needs no change because both tables use `ON DELETE CASCADE` on `users(id)`.
- [ ] BUILD: SQL, all `IF NOT EXISTS`:
  - `account_setup_reminders(id varchar(36) pk default gen_random_uuid(), user_id varchar references users(id) on delete cascade not null, template text not null, reminder_number int not null, channels text[] not null, steps text[] not null, sent_at timestamptz not null default now())`, unique `(user_id, template, reminder_number)`, index `(user_id, sent_at desc)`.
  - `account_setup_optouts(user_id varchar primary key references users(id) on delete cascade, created_at timestamptz not null default now())`.
- [ ] Legend hand-runs it in Neon; Claude confirms with `to_regclass` (read-only).
- [ ] Commit `feat(account-setup): migration 042 reminder log + opt-outs`.

### Task B2: Status

**Files:** Create `server/accountSetup/status.ts`, `server/accountSetup/status.test.ts`, `server/routes/accountSetup.ts`; Modify `server/index.ts`.

**Interfaces:** Produces `computeSetupSteps(input: SetupInput): SetupStatus` (pure) and `getAccountSetupStatus(userId: string, opts?: {syncStripe?: boolean}): Promise<SetupStatus | null>`.

- [ ] Write failing tests in `status.test.ts`: consumer with username → `complete:true`; passwordless consumer → `next:"password"`; business pending approval → approval `waiting`, `next` skips to username/none; business approved, no subscription → `next:"plan"`; grandfathered active row → plan `done`; waived complimentary active, period not ended → plan `done`; approved + plan, no Stripe → `next:"payouts"`; photographer onboarded, no username → `next:"username"`; staff with inactive row → no payouts step.
- [ ] Run `npx tsx server/accountSetup/status.test.ts` → fails (module missing).
- [ ] Implement; business plan check calls `isSubscriptionProvisioned` from `server/complimentary.ts`; Stripe self-heal via `stripeService.syncOnboardingStatus` (business, photographer) only when `syncStripe` is true; staff reads the stored flag.
- [ ] Run tests → pass. `npx tsc --noEmit` → no new errors over baseline.
- [ ] Route `GET /api/account-setup/status` (`authMiddleware`), `POST /api/account-setup/username`. Mount in `server/index.ts` after `vendorSubscriptionRouter`.
- [ ] Commit.

### Task B3: Claim at sign-in

**Files:** Create `server/accountSetup/claim.ts`; Modify `server/routes.ts` (mobile login `!user.password` branch only), `server/routes/accountSetup.ts`.

**Interfaces:** Consumes B2. Produces `isClaimable(user): boolean` (no password, no apple_id, no google_sub, has email, `isUserAllowedToAuthenticate`), `issueClaimCode(user): Promise<"sent"|"recent">`, `issueClaimLinkToken(user): Promise<string>`.

- [ ] AUDIT: quote the current `!user.password` branch in `/api/auth/mobile/login`; confirm `verify-code` and `reset-password` are untouched.
- [ ] REGRESSION: callers of `/api/auth/mobile/login` (app `api.mobileLogin`, web BFF `app/api/login/route.ts`, LHB/Lana login BFFs) all read `error.message` on non-2xx → new code still shows a sentence. `/api/auth/login` stays unchanged (only caller: web accept-invite BFF).
- [ ] Tests (pure, `claim.test.ts`): `isClaimable` truth table; resend rule (code issued 30 s ago → `"recent"`, 90 s ago → new code).
- [ ] Implement `issueClaimCode` with the same hash/expiry/attempt fields as `forgot-password/send-code` (10 min, sha256) and a branded "Your Outsyde code" email; `issueClaimLinkToken` writes `reset_token_hash` with a 7-day expiry.
- [ ] Insert the claimable branch before the existing generic 401 in `/api/auth/mobile/login`.
- [ ] `POST /api/account-setup/claim`: verify token like `reset-password` (hash compare + expiry); refuse `ALREADY_CLAIMED`; validate username with `validateUsername`; uniqueness via `getUserByUsername`; on 23505 unique violation return `USERNAME_TAKEN`; then one `updateUser` setting password + username and clearing reset fields; revoke refresh tokens; issue tokens exactly like mobile login (payload with businessId/photographerId); return the mobile-login shape.
- [ ] `POST /api/account-setup/send-code` with `strictAuthRateLimiter`-equivalent limiter.
- [ ] Local HTTP test against scratch Postgres (pattern of `complimentaryLinks.http.test.ts`): passwordless login → 401 ACCOUNT_NEEDS_SETUP; verify-code → token; claim → 200 with accessToken; login with new password → 200; claim again → 409 ALREADY_CLAIMED.
- [ ] Commit.

### Task B4: Stripe returns

**Files:** Modify `server/Photographers/photographers.controller.ts` (`startStripeOnboarding`), `server/routes.ts` (vendor create-link, staff create-link, connect-return, connect-refresh).

- [ ] AUDIT: quote current photographer return URLs (built from request host → `outsyde-backend.onrender.com/photographer-dashboard`), and the connect-return branches.
- [ ] REGRESSION: callers — app `startPhotographerStripeOnboarding` (PhotographerOnboardingScreen, PhotographerDashboardScreen), web BFF `app/api/photographer/me/stripe-onboarding`; vendor create-link (app ×4 call sites, web vendor-dashboard BFF, vendor sites via `returnOrigin`); staff create-link (app only). Existing `type` values keep their exact behavior.
- [ ] Photographer: return/refresh become `${API_BASE_URL}/api/stripe/connect-{return,refresh}?account=…&type=photographer` (app deep link, marked complete by the existing branch); with `webRedirect:true` → `type=photographer-web` (marks complete, redirects `FRONTEND_URL/photographer-dashboard?stripe=success`); with `returnTo:"finish"` add `&return=finish`.
- [ ] Vendor and staff create-link: `returnTo:"finish"` → web types with `&return=finish`.
- [ ] connect-return / connect-refresh: after the existing marking logic, if `return=finish` → redirect `FRONTEND_URL/finish?stripe=done|refresh`. New `photographer-web` branch added beside `photographer`.
- [ ] Commit.

### Task B5: Emails

**Files:** Create `server/accountSetup/emails.ts`.

- [ ] Tests: `unsubscribeUrl` → `verifyUnsubscribeSig` round-trip true, tampered user id false.
- [ ] `sendClaimEmail({to, firstName, claimUrl})` and `sendStepsLeftEmail({to, name, role, steps})` with copy from the mockups, `List-Unsubscribe` header, CAN-SPAM footer. Signature = HMAC-SHA256(`JWT_SECRET`, `"setup-unsub:"+userId`), hex, first 32 chars.
- [ ] Unsubscribe route inserts into `account_setup_optouts` (`ON CONFLICT DO NOTHING`).
- [ ] Commit.

### Task B6: Reminder job

**Files:** Create `server/accountSetup/reminders.ts`, `reminders.test.ts`; Modify `server/index.ts`, `server/routes/accountSetup.ts`.

**Interfaces:** `planReminders(candidates, log, now): PlannedReminder[]` (pure) where a reminder is due if: reminder 1 → account age ≥ 24 h; reminder n>1 → previous sent ≥ {3,7,14}[n-2] days after reminder 1; max 4; template `claim` if `password` missing else `steps_left`; actionable steps exclude `approval`.

- [ ] Tests: age 2 h → none; age 2 d, no log → #1; #1 sent 2 d ago → none; #1 sent 3 d ago → #2; 4 sent → none; opted out → none; complete → none.
- [ ] `sendDueReminders({dryRun})` loads candidates (exclusions above), recomputes status with `syncStripe:true`, sends email (+ `sendExpoPush` when token present), inserts log row; send window 10:00–19:00 America/New_York.
- [ ] `startAccountSetupReminderJob()` hourly `setInterval`, returns immediately unless `ACCOUNT_SETUP_REMINDERS_ENABLED === "true"`.
- [ ] Admin `preview` / `send` routes behind `requirePlatformAdmin`.
- [ ] Commit.

### Task B7: Save signup source

- [ ] `storage.createUser` adds `source: insertUser.source ?? null`. REGRESSION: `InsertUser` already has `source` (schema line ~265); five createUser callers unaffected.
- [ ] Commit; open backend PR with the full diff stat for Legend.

### Task W1: /claim and login hand-off [Web]

- [ ] AUDIT: quote `app/login/page.tsx` submit handler and `app/api/login/route.ts` error pass-through.
- [ ] BFF `app/api/login/route.ts`: include `code` and `email` in the error JSON (additive).
- [ ] `app/claim/page.tsx`: entry with `?token&email` → password step; with `?email` only (from login) → code step (calls `/api/auth/forgot-password/verify-code` via BFF) → password → username (live check `/api/users/check-username/:u`) → done screen (App Store button + Continue on web). Expired token → "Send me a code".
- [ ] BFFs: `app/api/account-setup/{claim,send-code,verify-code}/route.ts`; claim BFF sets `outsyde_access_token` cookie exactly like `app/api/login/route.ts`.
- [ ] Login page: on `code === "ACCOUNT_NEEDS_SETUP"` → `router.push('/claim?email=…')`. Signup pages: "Email already registered" → link "Is this you? Finish your account" → `/claim?email=…` (after calling send-code).
- [ ] Commit, PR.

### Task W2: /finish [Web]

- [ ] `middleware.ts` matcher adds `/finish` (redirect to `/login?return=/finish`).
- [ ] `app/finish/page.tsx` renders `GET /api/account-setup/status` via BFF; buttons: plan → `/subscription?return=finish`; business payouts → vendor create-link BFF with `returnTo:"finish"`; photographer → photographer BFF with `returnTo:"finish"`; staff → new BFF to staff create-link with `returnTo:"finish"`; username → inline form → `POST /api/account-setup/username`. "I already finished on Stripe — check again" refetches status.
- [ ] `app/subscription/success/page.tsx`: primary button "Continue setup" → `/finish` on the web; keep the app button as secondary.
- [ ] Commit, PR.

### Task W3: Universal links file [Web]

- [ ] `public/.well-known/apple-app-site-association` (no extension, `application/json` via `next.config` headers) with `applinks` for `/claim*` and `/finish*` for the app's Team ID + `com.outsyde.app`. Team ID comes from Legend's Apple account (UNVERIFIED until provided).
- [ ] Commit, PR.

### Task A1–A3: App [App]

- [ ] AUDIT: quote AuthContext `login` error path, login screen error display, RootNavigator stack, `addNotificationResponseReceivedListener` handler.
- [ ] A1 `ClaimAccountScreen` (code → password → username → signed in using the claim response exactly like a login response). AuthContext `login` returns `{needsSetup:true, email, firstName}` on `ACCOUNT_NEEDS_SETUP`; login screen navigates to it. Signup "Email already registered" → same screen.
- [ ] A2 `FinishSetupScreen` (all roles; steps from `/api/account-setup/status`; plan → `SubscriptionPlan`; business payouts → `startVendorStripeOnboarding`; photographer → `startPhotographerStripeOnboarding`; staff → staff create-link; username inline). Shown once per cold launch after sign-in when `complete === false` and `next !== "approval"`; `FinishSetupCard` on home until complete.
- [ ] A3 push tap: `data.type === "account_setup"` → navigate `FinishSetup`; `app.json` `ios.associatedDomains: ["applinks:www.goutsyde.com"]`; Linking handler routes `/claim` and `/finish` URLs to the two screens.
- [ ] Build with EAS, TestFlight smoke test, submit.

### Launch

- [ ] Backend + web merged and deployed; `/claim` and `/finish` smoke-tested on production with a test account.
- [ ] Legend reviews `GET /api/admin/account-setup/preview`.
- [ ] Set `ACCOUNT_SETUP_REMINDERS_ENABLED=true` on Render; first run; spot-check Resend logs.
- [ ] Vault updates (backups first): auth, email, push, Stripe notes, Known Broken Routes (photographer return fixed), Priority Queue.

## Open items (not blocking backend work)

- How the 26 passwordless accounts were inserted (no code path creates them). If Wix keeps feeding new rows, that import should set `source='wix'`.
- Apple Team ID for the association file.
- Separate security fix: `/api/search` trusts `viewerUserId` from the query string for admin scope.
