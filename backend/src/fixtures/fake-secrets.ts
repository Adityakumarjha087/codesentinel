/**
 * Fake credentials for fixtures and tests, assembled at runtime from fragments so that no
 * secret-shaped literal (which secret scanners / push protection would flag) is ever committed.
 */
export type FakeSecretKind = 'stripe' | 'aws' | 'github' | 'slack';

export function fakeSecret(kind: FakeSecretKind): string {
  switch (kind) {
    case 'stripe':
      return ['sk', 'live', `51CodeSentinelFake${'X'.repeat(16)}`].join('_');
    case 'aws':
      return ['AK', 'IA', 'FAKE'.repeat(4)].join('');
    case 'github':
      return ['ghp', 'F'.repeat(36)].join('_');
    case 'slack':
      return ['xo', 'xb-', '0'.repeat(10), '-', 'F'.repeat(24)].join('');
  }
}

export const FAKE_STRIPE_KEY = fakeSecret('stripe');
