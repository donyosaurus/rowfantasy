// Payment Provider Factory

import type { PaymentProvider } from './types.ts';
import { MockProviderAdapter } from './mock-adapter.ts';

// Room for future providers (e.g., 'aeropay') alongside 'mock'.
export type ProviderType = 'mock';

export function getPaymentProvider(providerType?: ProviderType): PaymentProvider {
  const provider = providerType || (Deno.env.get('PAYMENTS_PROVIDER') as ProviderType) || 'mock';

  console.log(`[PaymentFactory] Creating provider: ${provider}`);

  switch (provider) {
    case 'mock':
      return new MockProviderAdapter();

    default:
      console.warn(`[PaymentFactory] Unknown provider: ${provider}, defaulting to mock`);
      return new MockProviderAdapter();
  }
}
