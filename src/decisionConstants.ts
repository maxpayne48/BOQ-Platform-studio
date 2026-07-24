// =========================================================
// SHARED DECISION CONSTANTS - Single Source of Truth (ADR-0001)
// =========================================================
// Every threshold that participates in a business decision lives HERE and only here.
// server.ts, the engines, and the frontend all import these. Writing a literal
// `>= 75`, `>= 50`, `* 0.5`, `* 2`, or `>= 80` anywhere else in a decision context
// is a regression against ADR-0001 (docs/adr/0001-single-source-of-truth-commercial-decision.md).

/**
 * Minimum confidence (%) for a recommendation to be Auto Approved by the
 * Commercial Decision Engine. Also the frontend's confidence badge color cutoff -
 * the UI must never invent a second threshold (the old 80 vs 75 disagreement).
 */
export const CONFIDENCE_APPROVAL_THRESHOLD = 75;

/**
 * Minimum sub-score (%) for a per-item validation category (specification
 * confidence, engineering adjustment confidence) to count as a PASS in the
 * item's validation report.
 */
export const VALIDATION_MIN_SUBSCORE = 50;

/**
 * Rate plausibility band relative to the item's own historical evidence range:
 * a recommended rate below (min * LOW) or above (max * HIGH) fails commercial
 * validation and is flagged "Rate Outside Historical Range". Wide enough to
 * never trip on legitimate engineering adjustments, tight enough to catch the
 * genuine mismatches observed in practice (~0.08x to ~11x).
 */
export const RATE_PLAUSIBILITY_LOW_MULTIPLIER = 0.5;
export const RATE_PLAUSIBILITY_HIGH_MULTIPLIER = 2;

/**
 * Deviation (%) from the selected historical rate above which the
 * self-validation second pass re-evaluates an item.
 */
export const SELF_VALIDATION_MAX_DEVIATION_PERCENT = 25;

/**
 * Pricing-confidence (%) below which an item gets the "Low Pricing Confidence"
 * attention flag on the dashboard (informational surface only).
 */
export const LOW_PRICING_CONFIDENCE_FLAG_THRESHOLD = 70;

/**
 * Pricing-confidence (%) below which the self-validation second pass considers
 * an item weakly supported and attempts a better-evidenced re-estimate.
 */
export const SELF_VALIDATION_MIN_PRICING_CONFIDENCE = 50;
