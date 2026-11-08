/**
 * PUSH_DISABLED: an off switch for every push notification (payment methods Step 5, Legend 2026-11-08).
 *
 * The Stripe test backend runs on a copy of production data, and Expo sends to any stored token without a key
 * (expoPushService.ts), so its jobs would otherwise push real customers. With PUSH_DISABLED=true nothing goes
 * to Expo: direct pushes report sent, broadcasts get "sent" tickets and "ok" receipts so their records finish.
 * Only the exact string "true" turns it on; production leaves it unset.
 */
import type { ExpoPushReceipt, ExpoPushTicket } from "expo-server-sdk";

export function pushDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PUSH_DISABLED === "true";
}

let seq = 0;
export function offTickets(count: number): ExpoPushTicket[] {
  const stamp = Date.now().toString(36);
  return Array.from({ length: count }, () => ({ status: "ok", id: `push-off-${stamp}-${++seq}` }) as ExpoPushTicket);
}

export function offReceipts(ids: string[]): Record<string, ExpoPushReceipt> {
  return Object.fromEntries(ids.map((id) => [id, { status: "ok" } as ExpoPushReceipt]));
}
