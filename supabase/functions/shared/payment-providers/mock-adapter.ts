// Mock Payment Provider - For Testing and Development

import type {
  PaymentProvider,
  CheckoutRequest,
  CheckoutResponse,
  CaptureRequest,
  CaptureResponse,
  PayoutRequest,
  PayoutResponse,
  RefundRequest,
  RefundResponse,
  TransactionStatusRequest,
  TransactionStatusResponse,
  WebhookVerificationRequest,
  WebhookEvent,
} from './types.ts';

export class MockPaymentAdapter {
  async processPayment(amount: number, currency: string): Promise<{ success: boolean; transactionId: string }> {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 100));
    return {
      success: true,
      transactionId: `mock_${crypto.randomUUID()}`,
    };
  }

  /**
   * Refund a previously captured payment. Called by deposit flow when the
   * post-charge atomic RPC determinately rejects (Pass C contract).
   * Real adapters (Aeropay, etc.) MUST implement this with provider-side
   * reversal/refund APIs and surface failures so callers can write a
   * `deposit_post_charge_refund_failed` critical compliance log.
   */
  async refundPayment(
    transactionId: string,
    amountCents: number,
    reason: string,
  ): Promise<{ success: boolean; refundId: string }> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      success: true,
      refundId: `mock_refund_${crypto.randomUUID()}`,
    };
  }
}

export class MockProviderAdapter implements PaymentProvider {
  name = 'mock';
  private transactions: Map<string, any> = new Map();

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResponse> {
    const sessionId = `mock_checkout_${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    
    this.transactions.set(sessionId, {
      userId: request.userId,
      amountCents: request.amountCents,
      stateCode: request.stateCode,
      status: 'pending',
      createdAt: new Date(),
    });

    return {
      sessionId,
      checkoutUrl: `https://mock-payment.example.com/checkout/${sessionId}`,
      expiresAt,
    };
  }

  async captureDeposit(request: CaptureRequest): Promise<CaptureResponse> {
    const transaction = this.transactions.get(request.sessionId);
    
    if (!transaction) {
      throw new Error('Transaction not found');
    }

    transaction.status = 'succeeded';
    transaction.transactionId = `mock_txn_${crypto.randomUUID()}`;
    
    return {
      success: true,
      transactionId: transaction.transactionId,
      feeCents: Math.floor(transaction.amountCents * 0.029) + 30, // 2.9% + $0.30
    };
  }

  async initiatePayout(request: PayoutRequest): Promise<PayoutResponse> {
    const payoutId = `mock_payout_${crypto.randomUUID()}`;
    
    this.transactions.set(payoutId, {
      userId: request.userId,
      amountCents: request.amountCents,
      type: 'payout',
      status: 'pending',
      createdAt: new Date(),
    });

    return {
      success: true,
      payoutId,
      estimatedArrival: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days
    };
  }

  async refund(request: RefundRequest): Promise<RefundResponse> {
    const refundId = `mock_refund_${crypto.randomUUID()}`;
    
    return {
      success: true,
      refundId,
    };
  }

  async getTransactionStatus(request: TransactionStatusRequest): Promise<TransactionStatusResponse> {
    // Mock implementation - always return succeeded for testing
    return {
      status: 'succeeded',
      amountCents: 10000,
      feeCents: 320,
    };
  }

  async verifyWebhook(request: WebhookVerificationRequest): Promise<boolean> {
    // Mock always accepts webhooks
    return true;
  }

  async handleWebhook(payload: any): Promise<WebhookEvent> {
    // Mock webhook handler
    return {
      eventType: payload.type || 'payment.succeeded',
      providerSessionId: payload.sessionId,
      providerTransactionId: payload.transactionId,
      amountCents: payload.amount || 0,
      feeCents: payload.fee || 0,
      status: payload.status || 'succeeded',
      metadata: payload.metadata || {},
    };
  }
}
