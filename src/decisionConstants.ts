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

/**
 * Hard confidence floor (2026-07-27, "never fabricate, never guess, always flag"). These three
 * constants define the minimum evidence bar a STATISTICAL-EVIDENCE-sourced rate (anything backed
 * by `item.marketRateStatistics`, i.e. ProjectCalibrationEngine.selectHistoricalEvidence or
 * ProgressiveMatchingEngine's relaxed tiers) must clear before CommercialDecisionEngine will let
 * it become a real, auto-populated recommendation. Falling short of ANY of these routes the item
 * to Manual Pricing with `recommendedRate` cleared - never a fallback average, nearest-loose-
 * match, or zero left silently in place. This is a SEPARATE, stricter gate from the existing
 * CONFIDENCE_APPROVAL_THRESHOLD (which decides Auto Approved vs. Needs Review for evidence that
 * already cleared this floor) - this floor decides whether there was ever enough evidence to
 * price the item AT ALL.
 *
 * Calibrated from real data, not arbitrary: a full cross-project self-replay run (6 historical
 * projects, 2,643 ground-truth items - see docs/audit/0002-identity-and-evidence-integrity-audit.md
 * "Follow-up Fix 6") found EVERY currently-legitimate match (all 2,387 within-tolerance items)
 * sits at `selectedMatchScore >= 53` and `projectSimilarity == 95` (self-replay's constant, since
 * a project is always compared against its own real twin). These floors are set safely below that
 * observed range - MIN_SELECTED_MATCH_SCORE_FOR_AUTO_RATE far enough below 53 to guarantee zero
 * regression on any currently-good match, MIN_PROJECT_SIMILARITY_FOR_AUTO_RATE set just above
 * Stage-1's own MIN_PROJECT_SIMILARITY_TO_SHORTLIST (30%, src/RecommendationEngineV2.ts) so a
 * project that barely cleared the shortlist bar cannot also supply a confidently-priced rate -
 * this specific number would have gated the original Kohler 41%-similarity incident
 * (docs/audit/0002-identity-and-evidence-integrity-audit.md §1), which is exactly the failure
 * shape this floor exists to prevent from recurring on a future non-replay upload. Both floors
 * measured ~0 effect on THIS session's self-replay baseline BY DESIGN (self-replay rarely
 * exercises genuinely weak evidence - a project matched against itself almost always finds either
 * a real twin or nothing at all) - they are a defensive backstop for real, non-replay uploads
 * (exactly where the Lifting Station and Kohler-41% incidents actually happened), not a fix aimed
 * at moving the self-replay accuracy number.
 */
export const MIN_SELECTED_MATCH_SCORE_FOR_AUTO_RATE = 35;
export const MIN_PROJECT_SIMILARITY_FOR_AUTO_RATE = 40;

/**
 * Minimum corroborating historical rates a RELAXED-tier match (ProgressiveMatchingEngine's
 * Specification/Material/Functional Match ladder) must have before it may price an item at all -
 * moved here from a local constant in src/ProgressiveMatchingEngine.ts per this file's own "every
 * threshold lives here" rule (a real, if minor, ADR-0001 violation found during the Part 2 code-
 * path audit). Deliberately NOT applied to the primary exact/near-exact match path, which
 * legitimately accepts a single strong match (referenceCount 1 is the median for every
 * currently-good self-replay match - requiring corroboration there would break the single most
 * common correct case: an item that IS its own historical twin).
 */
export const MIN_RELAXED_TIER_REFERENCES = 2;
