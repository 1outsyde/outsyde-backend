/**
 * How long after an event ends the host payout becomes due.
 *
 * Kept in sync BY HAND with the SQL literal `e.ends_at + interval '3 days'` in eventPayouts.ts
 * (createDuePayouts, in both the candidate query and the create statement). The payout job SQL is not built
 * from this constant, so change all three places together. A test pins this value to 3.
 */
export const HOST_PAYOUT_DELAY_DAYS = 3;
