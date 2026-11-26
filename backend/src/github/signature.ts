import { createHmac, timingSafeEqual } from 'node:crypto';

export function signPayload(secret: string, payload: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

/** Constant-time verification of GitHub's `X-Hub-Signature-256` header. */
export function verifySignature(secret: string, payload: string | Buffer, signature: string | undefined | null): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = Buffer.from(signPayload(secret, payload));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
