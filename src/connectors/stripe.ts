// Read-only Stripe observation. Use a restricted key with read access to Refunds
// and Charges, which is all this calls. The key stays in this process.
//
// Evidence modes:
//   full     includes the customer email
//   minimal  leaves the customer out, so Postcept skips the customer check
//            rather than passing it

import type { RefundFacts } from "../envelope.js";

const STRIPE_API = "https://api.stripe.com";

interface StripeRefund {
  id: string;
  amount: number;
  currency: string;
  status: string;
  charge: string | null;
  metadata?: Record<string, string>;
}

async function stripeGet<T>(apiKey: string, path: string): Promise<T | null> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Stripe ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

function operationRef(refund: StripeRefund): string | null {
  return refund.metadata?.operation_id ?? refund.metadata?.idempotency_key ?? null;
}

export async function observeStripeRefund(
  apiKey: string,
  refundId: string,
  evidenceMode: "full" | "minimal" = "full"
): Promise<RefundFacts> {
  const refund = await stripeGet<StripeRefund>(apiKey, `/v1/refunds/${encodeURIComponent(refundId)}`);
  if (!refund) {
    return { exists: false, duplicate_refund_ids: [], duplicates_available: true };
  }

  let customer: string | null = null;
  if (evidenceMode === "full" && refund.charge) {
    try {
      const charge = await stripeGet<{
        billing_details?: { email?: string | null };
        receipt_email?: string | null;
      }>(apiKey, `/v1/charges/${encodeURIComponent(refund.charge)}`);
      customer = charge?.billing_details?.email ?? charge?.receipt_email ?? null;
    } catch {
      customer = null; // Postcept then skips the customer check
    }
  }

  // Other refunds on the same charge that share this refund's operation
  // reference. If the check can't run, report that rather than assuming none.
  let duplicateIds: string[] = [];
  let duplicatesAvailable = false;
  const opRef = operationRef(refund);
  if (refund.charge && opRef) {
    try {
      const listing = await stripeGet<{ data: StripeRefund[] }>(
        apiKey,
        `/v1/refunds?charge=${encodeURIComponent(refund.charge)}&limit=100`
      );
      duplicateIds = (listing?.data ?? [])
        .filter((r) => r.id !== refund.id && operationRef(r) === opRef)
        .map((r) => r.id);
      duplicatesAvailable = true;
    } catch {
      duplicatesAvailable = false;
    }
  }

  return {
    exists: true,
    refund_id: refund.id,
    charge_id: refund.charge,
    amount_cents: refund.amount,
    currency: refund.currency,
    customer,
    status: refund.status,
    operation_ref: opRef,
    duplicate_refund_ids: duplicateIds,
    duplicates_available: duplicatesAvailable,
  };
}
