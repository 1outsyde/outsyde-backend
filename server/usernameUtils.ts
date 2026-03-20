/**
 * Username validation and enforcement utilities.
 * Used by all signup, update, and search paths.
 */

export interface UsernameValidation {
  valid: boolean;
  cleaned?: string;
  reason?: string;
}

/**
 * Validate and clean a username. Enforces:
 * - Lowercase only
 * - a-z, 0-9, underscore only
 * - 3-20 characters
 * - Strips @ prefix
 * - Not null or empty
 */
export function validateUsername(username: string | null | undefined): UsernameValidation {
  if (!username || typeof username !== 'string') {
    return { valid: false, reason: 'Username is required' };
  }

  const cleaned = username.toLowerCase().replace(/^@/, '').trim();

  if (cleaned.length === 0) {
    return { valid: false, reason: 'Username is required' };
  }
  if (cleaned.length < 3) {
    return { valid: false, reason: 'Username must be at least 3 characters' };
  }
  if (cleaned.length > 20) {
    return { valid: false, reason: 'Username cannot exceed 20 characters' };
  }
  if (!/^[a-z0-9_]+$/.test(cleaned)) {
    return { valid: false, reason: 'Username can only contain lowercase letters, numbers, and underscores' };
  }

  return { valid: true, cleaned };
}

/**
 * Check if a user can change their username (14-day lock).
 * Returns the earliest eligible date if locked.
 */
export function canChangeUsername(usernameLastChangedAt: Date | string | null | undefined): {
  allowed: boolean;
  eligibleDate?: string;
  daysRemaining?: number;
} {
  if (!usernameLastChangedAt) return { allowed: true };

  const lastChanged = new Date(usernameLastChangedAt);
  if (isNaN(lastChanged.getTime())) return { allowed: true };

  const LOCK_DAYS = 14;
  const lockMs = LOCK_DAYS * 24 * 60 * 60 * 1000;
  const elapsed = Date.now() - lastChanged.getTime();

  if (elapsed >= lockMs) return { allowed: true };

  const eligibleDate = new Date(lastChanged.getTime() + lockMs);
  const daysRemaining = Math.ceil((lockMs - elapsed) / (1000 * 60 * 60 * 24));

  return {
    allowed: false,
    eligibleDate: eligibleDate.toISOString().split('T')[0],
    daysRemaining,
  };
}

/**
 * Clean a search query that may contain @ prefix.
 */
export function cleanUsernameForSearch(query: string): string {
  return query.toLowerCase().replace(/^@/, '').trim();
}
