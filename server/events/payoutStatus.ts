/** Host payout status shown on the host summary (and reused by the admin events money views). */
export type PayoutStatus = "scheduled" | "paid" | "on_hold" | "payout_setup_needed" | "event_paused" | "none";
export type PayoutRow = { status: string; hold_reason: string | null } | undefined;

/** Status of the host payout. With no row yet, "payable" means the payout job would pay something (host_net_cents > 0). */
export function payoutStatusFor(row: PayoutRow, o: { eventStatus: string; payable: boolean; expectedAt: string | null }): PayoutStatus {
  if (!row) {
    if (o.eventStatus === "paused" && o.payable) return "event_paused";
    return o.expectedAt ? "scheduled" : "none";
  }
  if (row.status === "pending") return "scheduled";
  if (row.status === "paid") return "paid";
  if (row.status === "held") {
    if (row.hold_reason === "event_paused") return "event_paused";
    if (row.hold_reason && ["no_account", "not_complete", "stripe_not_ready"].includes(row.hold_reason)) return "payout_setup_needed";
  }
  return "on_hold";
}
