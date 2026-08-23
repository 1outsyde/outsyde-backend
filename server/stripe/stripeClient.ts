import Stripe from 'stripe';

let cachedCredentials: { publishableKey: string; secretKey: string } | null = null;

function getCredentials() {
  if (cachedCredentials) {
    return cachedCredentials;
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;

  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is required');
  }
  if (!publishableKey) {
    throw new Error('STRIPE_PUBLISHABLE_KEY environment variable is required');
  }

  cachedCredentials = { publishableKey, secretKey };
  return cachedCredentials;
}

export async function getUncachableStripeClient() {
  const { secretKey } = getCredentials();
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  console.log('[STRIPE_KEY_DIAG] length:', key.length);
  console.log('[STRIPE_KEY_DIAG] charCodes:', [...key].map(c => c.charCodeAt(0)));
  return new Stripe(secretKey);
}

export async function getStripePublishableKey() {
  const { publishableKey } = getCredentials();
  return publishableKey;
}

export async function getStripeSecretKey() {
  const { secretKey } = getCredentials();
  return secretKey;
}
