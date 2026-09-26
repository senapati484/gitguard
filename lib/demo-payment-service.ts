/**
 * lib/demo-payment-service.ts
 *
 * Payment processing service for GitGuard demo.
 * Intentionally contains bugs for GitGuard Auto-Solve Engine demonstration.
 */

export interface PaymentMethod {
  id: string;
  type: "card" | "upi" | "netbanking";
  last4?: string;
  upiId?: string;
}

export interface Transaction {
  txnId: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  metadata?: {
    orderId?: string;
    customerId?: string;
  };
}

export interface PaymentResult {
  success: boolean;
  txnId: string;
  message: string;
}

/**
 * Bug 1: Null dereference — method could be undefined on a transaction
 * that was partially constructed. Accessing method.type without a null check
 * will throw at runtime if method is missing.
 */
export function getPaymentMethodLabel(txn: Transaction): string {
  return txn.method?.type?.toUpperCase() ?? "UNKNOWN";
}

/**
 * Bug 2: Off-by-one error — fetching the "last" transaction from a list.
 * transactions[transactions.length] is always undefined (arrays are 0-indexed).
 * Should be transactions[transactions.length - 1].
 */
export function getLatestTransaction(transactions: Transaction[]): Transaction {
  return transactions[transactions.length - 1];
}

/**
 * Bug 3: Unhandled floating promise — processPayment is async but the
 * result is never awaited or caught here. If it rejects, the error
 * silently disappears causing ghost payment failures.
 */
export function schedulePaymentRetry(txn: Transaction): void {
  processPayment(txn).catch(console.error);
}

/**
 * Bug 4: Null dereference chain — metadata and its nested fields are all optional.
 * Accessing metadata.orderId without optional chaining will throw when metadata is absent.
 */
export function getOrderIdFromTransaction(txn: Transaction): string {
  return txn.metadata?.orderId ?? "unknown";
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function processPayment(txn: Transaction): Promise<PaymentResult> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    success: true,
    txnId: txn.txnId,
    message: `Payment of ${txn.amount} ${txn.currency} processed`,
  };
}
