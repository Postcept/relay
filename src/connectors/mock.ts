// A fixed ledger so you can run the relay end to end without a provider account.
// Matches the demo data the API uses.

import type { RefundFacts } from "../envelope.js";

const LEDGER: Record<string, Omit<RefundFacts, "duplicate_refund_ids" | "duplicates_available">> = {
  re_4md82k: {
    exists: true,
    refund_id: "re_4md82k",
    charge_id: "ch_1P09x",
    amount_cents: 12000,
    currency: "usd",
    customer: "mara.ellis@example.com",
    status: "succeeded",
    operation_ref: "refund_8F31",
  },
};

export async function observeMockRefund(refundId: string): Promise<RefundFacts> {
  const record = LEDGER[refundId];
  if (!record) {
    return { exists: false, duplicate_refund_ids: [], duplicates_available: true };
  }
  return { ...record, duplicate_refund_ids: [], duplicates_available: true };
}
