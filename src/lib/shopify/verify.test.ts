import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';

import { verifyShopifyHmac } from './verify';

const SECRET = 'shpss_test_secret';
const body = JSON.stringify({ id: 1234, name: '#1001' });

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64');
}

describe('verifyShopifyHmac', () => {
  it('accepts a correctly signed body', () => {
    expect(verifyShopifyHmac(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it('rejects a signature from the wrong secret', () => {
    expect(verifyShopifyHmac(body, sign(body, 'other'), SECRET)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifyShopifyHmac(body + ' ', sign(body, SECRET), SECRET)).toBe(
      false
    );
  });

  it('rejects a missing or malformed header', () => {
    expect(verifyShopifyHmac(body, null, SECRET)).toBe(false);
    expect(verifyShopifyHmac(body, '', SECRET)).toBe(false);
    expect(verifyShopifyHmac(body, 'not-base64!!', SECRET)).toBe(false);
  });
});
