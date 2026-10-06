// fees.ts — the per-order fee, in one place with no dependencies (checkout, refunds, the grader and the test checks
// all read this). Jason, 2026-09-26: $1.49 flat per order (was 99¢); modeled against Telnyx actuals and the apps' service fees.
export const SERVICE_FEE_CENTS = 149;
