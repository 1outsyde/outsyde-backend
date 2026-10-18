/**
 * Real name vs display name (Legend, 2026-10-18):
 *  - users.first_name + users.last_name = the person's REAL name. Shown only in transactions
 *    (orders, bookings, receipts, the emails about them, Stripe) and to admins.
 *  - users.name = the DISPLAY name. Shown everywhere else (feed, comments, followers, search,
 *    messaging, notifications, staff pickers). Falls back to @username, never to the real name.
 *  - A new account's display name is the person's first name (they can change it in their profile).
 */

type NameFields = {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  email?: string | null;
};

export const cleanName = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t.length > 0 ? t : null;
};

/** "Mary Ann Smith" → { firstName: "Mary", lastName: "Ann Smith" }. */
export function splitFullName(full: unknown): { firstName: string | null; lastName: string | null } {
  const t = cleanName(full);
  if (!t) return { firstName: null, lastName: null };
  const i = t.indexOf(" ");
  if (i === -1) return { firstName: t, lastName: null };
  return { firstName: t.slice(0, i), lastName: t.slice(i + 1) };
}

/**
 * Names to store for a new account. Clients send `name` = "First Last" (app, goutsyde.com, every
 * vendor site) and sometimes firstName/lastName too. The real name goes to first_name/last_name,
 * the display name (users.name) is the first name.
 */
export function namesForNewAccount(input: { name?: unknown; firstName?: unknown; lastName?: unknown; email?: unknown }): {
  name: string;
  firstName: string | null;
  lastName: string | null;
} {
  let firstName = cleanName(input.firstName);
  let lastName = cleanName(input.lastName);
  if (!firstName && !lastName) {
    ({ firstName, lastName } = splitFullName(input.name));
  } else if (!firstName && lastName) {
    firstName = splitFullName(input.name).firstName;
  }
  const emailPrefix = typeof input.email === "string" ? cleanName(input.email.split("@")[0]) : null;
  return { name: firstName || emailPrefix || "Outsyde member", firstName, lastName };
}

/** Real name for transactions and admin: "First Last", else the display name, else null. */
export function realName(u: NameFields | null | undefined): string | null {
  if (!u) return null;
  const full = cleanName([u.firstName, u.lastName].filter((p) => typeof p === "string").join(" "));
  return full || cleanName(u.name) || null;
}

/** Name other people see: display name, else @username. Never first/last name or email. */
export function publicDisplayName(u: NameFields | null | undefined): string | null {
  if (!u) return null;
  const name = cleanName(u.name);
  if (name) return name;
  const username = cleanName(u.username);
  return username ? `@${username}` : null;
}
