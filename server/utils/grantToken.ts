import crypto from 'crypto';

const SECRET = process.env.GRANT_LINK_SECRET!;
const SEPARATOR = '.';
const TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

interface GrantPayload {
  businessId: string;
  tierId: string;
  exp: number;
}

function sign(payload: GrantPayload): string {
  const data = JSON.stringify(payload);
  const encoded = Buffer.from(data).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SECRET)
    .update(encoded)
    .digest('base64url');
  return `${encoded}${SEPARATOR}${sig}`;
}

function verify(token: string): GrantPayload {
  const parts = token.split(SEPARATOR);
  if (parts.length !== 2) throw new Error('INVALID_TOKEN');
  const [encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', SECRET)
    .update(encoded)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('INVALID_SIGNATURE');
  }
  const payload: GrantPayload = JSON.parse(
    Buffer.from(encoded, 'base64url').toString()
  );
  if (Date.now() > payload.exp) throw new Error('TOKEN_EXPIRED');
  return payload;
}

function generate(businessId: string, tierId: string): string {
  return sign({ businessId, tierId, exp: Date.now() + TTL_MS });
}

export const grantToken = { generate, verify };
