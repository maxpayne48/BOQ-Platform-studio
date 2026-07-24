// =========================================================
// COMMERCIAL DECISION ENGINE - the Single Source of Truth (ADR-0001)
// =========================================================
// This is the ONLY module allowed to decide whether a recommendation is
// Auto Approved, Needs Review, or Manual Pricing, and the ONLY module allowed
// to compute approval/accuracy metrics over items. It does not price anything -
// the five-stage pricing chain (RecommendationEngineV2 baseline -> Engineering
// Adjustment -> Progressive Matching -> Project Calibration -> Self-Validation)
// remains the authority on the rate itself. This engine interprets the final
// state of that chain, exactly once per item, into one immutable
// CommercialDecision object that every downstream surface (dashboard, table and
// drawer badges, auditor, export filter, analytics, system health) renders
// read-only.
//
// Adding an `if (confidence >= N)` or a bucket count anywhere outside this file
// is a reviewable violation of ADR-0001.

import { RFQItem, CommercialDecision, ApprovalStatus, DecisionReasonCode } from "./types.js";
import { CONFIDENCE_APPROVAL_THRESHOLD } from "./decisionConstants.js";

export interface ApprovalMetrics {
  totalItems: number;
  pending: number;
  autoApproved: number;
  needsReview: number;
  manualPricing: number;
  ratedItems: number;      // everything except Pending
  overridden: number;
  /** % of rated items that are Auto Approved (the platform's one "accuracy" number). */
  approvalAccuracy: number;
  /** % of rated items whose recommendation the estimator did NOT override. */
  nonOverrideRate: number;
}

export class CommercialDecisionEngine {
  /**
   * An item counts as rated once the recommendation pipeline has produced any
   * output for it (or a human has overridden it). Derived from pipeline artifacts,
   * never from a status string, so it cannot drift from reality.
   */
  static isRated(item: RFQItem): boolean {
    return (
      item.isOverridden === true ||
      !!item.recommendationTrace ||
      (item.confidenceScore ?? 0) > 0 ||
      (item.recommendedRate ?? 0) > 0
    );
  }

  /**
   * THE approval rule. Called exactly once per item after the pricing chain
   * (and again only if the item's inputs genuinely change, e.g. an estimator
   * override). Everything else reads the result.
   *
   * Validation gates approval (confirmed product decision, ADR-0001): an item is
   * Auto Approved only when confidence clears CONFIDENCE_APPROVAL_THRESHOLD AND
   * every validation category passes. This is deliberately stricter than the
   * legacy `item.status`, which ignored validation entirely.
   */
  static deriveApprovalDecision(item: RFQItem): CommercialDecision {
    const stats = item.marketRateStatistics;
    const acceptedEvidenceCount = stats
      ? (stats.historicalEvidence?.length ?? stats.referenceCount ?? 0)
      : 0;
    const rejectedEvidenceCount =
      (item.rejectedHistoricalCandidates?.length ?? 0) + (stats?.rejectedEvidence?.length ?? 0);

    const rateProvenance = CommercialDecisionEngine.deriveRateProvenance(item);

    // Prefer the 6-facet overall confidence when the calibration layer produced
    // one; the pipeline confidenceScore is the fallback for items that never
    // reached calibration.
    const confidence = item.overallConfidence ?? item.confidenceScore ?? 0;

    const build = (
      approvalStatus: ApprovalStatus,
      reasonCode: DecisionReasonCode,
      decisionSummary: string,
      failedValidations: string[]
    ): CommercialDecision =>
      Object.freeze({
        recommendationId: item.id,
        recommendedRate: item.isOverridden && item.overriddenRate ? item.overriddenRate : item.recommendedRate,
        selectedHistoricalRate: stats?.selectedRate,
        approvalStatus,
        reasonCode,
        decisionSummary,
        confidence,
        evidenceStrength: CommercialDecisionEngine.gradeEvidenceStrength(item, acceptedEvidenceCount),
        acceptedEvidenceCount,
        rejectedEvidenceCount,
        failedValidations,
        rateProvenance
      });

    if (!CommercialDecisionEngine.isRated(item)) {
      return build("Pending", "NOT_RATED", "Recommendation has not been generated for this item yet.", []);
    }

    if (item.isOverridden) {
      return build(
        "Auto Approved",
        "ESTIMATOR_OVERRIDE",
        `Rate ₹${(item.overriddenRate ?? item.recommendedRate).toFixed(2)} manually approved by the estimator; overrides are final.`,
        []
      );
    }

    // Zero evidence of any kind: no master-catalog match, no relaxed-tier market
    // estimate, no engineering dimensional model, no selected historical evidence.
    // There is nothing behind the number - it must be priced manually.
    const zeroEvidence =
      !item.matchedMasterId &&
      !item.matchTier &&
      !item.engineeringAdjustment?.applied &&
      !stats;
    if (zeroEvidence) {
      return build(
        "Manual Pricing",
        "NO_EVIDENCE",
        "No commercially-equivalent historical evidence, engineering family, or relaxed-tier market estimate exists for this item. Manual pricing required.",
        []
      );
    }

    const failedValidations = item.validationResults
      ? Object.entries(item.validationResults)
          .filter(([, v]) => v && v.pass === false)
          .map(([key]) => key.replace(/Validation$/, ""))
      : [];
    const confidenceOk = confidence >= CONFIDENCE_APPROVAL_THRESHOLD;
    const validationOk = failedValidations.length === 0;

    if (confidenceOk && validationOk) {
      return build(
        "Auto Approved",
        "APPROVED",
        `Confidence ${confidence}% meets the ${CONFIDENCE_APPROVAL_THRESHOLD}% approval threshold and all validation checks passed.`,
        []
      );
    }

    const reasonCode: DecisionReasonCode = !confidenceOk && !validationOk
      ? "LOW_CONFIDENCE_AND_VALIDATION_FAILED"
      : !confidenceOk
        ? "LOW_CONFIDENCE"
        : "VALIDATION_FAILED";
    const parts: string[] = [];
    if (!confidenceOk) parts.push(`confidence ${confidence}% is below the ${CONFIDENCE_APPROVAL_THRESHOLD}% approval threshold`);
    if (!validationOk) parts.push(`validation failed: ${failedValidations.join(", ")}`);
    return build("Needs Review", reasonCode, `Estimator review required - ${parts.join("; ")}.`, failedValidations);
  }

  /** Which pipeline stage is responsible for the item's FINAL rate. */
  static deriveRateProvenance(item: RFQItem): string {
    return item.isOverridden
      ? "Estimator Override"
      : item.calibrationApplied
        ? "Self-Validation / Calibration"
        : item.matchTier
          ? `Progressive Match (${item.matchTier})`
          : item.engineeringAdjustment?.applied
            ? `Engineering Adjustment (${item.engineeringAdjustment.mathematicalModel})`
            : item.recommendationTrace?.rateSource || "Recommendation Baseline";
  }

  /**
   * Audit 0002 fix 4 (+ follow-up fix after a reported drawer inconsistency on "Tile - Type -01
   * (1200mm x 1200mm)"): the recommendation trace is written once by the baseline stage and was
   * never updated when a later stage (engineering adjustment, progressive matching, calibration,
   * self-validation, estimator override) overwrote the rate - so the trace could tell a
   * fabricated provenance story ("₹3,500 historical rate used directly") for an item whose real
   * final rate was something else entirely. Same single-writer-at-the-end pattern as the
   * approval decision: this engine reconciles the trace exactly once, here, and no pricing stage
   * edits it mid-flight. The baseline stage's original explanation is preserved verbatim in
   * `baselineExplanation` (set once, idempotent) so lineage stays visible without contradiction.
   *
   * `historicalUnitRate` gets the same treatment as `recommendedUnitRate`: it is frozen by the
   * baseline stage at whatever the initially-matched master item's own rate was, but a later
   * calibration/self-validation pass can select a DIFFERENT historical observation entirely
   * (marketRateStatistics.selectedRate) as the actual evidence behind the final decision. Left
   * unreconciled, the drawer could show a "Historical Unit Rate" that no longer matches the
   * "Selected" row in its own Historical Evidence table - reconciled here to whichever selected
   * rate is authoritative at finalize time.
   */
  private static reconcileRecommendationTrace(item: RFQItem): void {
    const trace = item.recommendationTrace;
    if (!trace) return;

    const finalRate = item.isOverridden && item.overriddenRate ? item.overriddenRate : item.recommendedRate;
    if (trace.baselineExplanation === undefined) {
      trace.baselineExplanation = trace.explanation || "";
    }

    const selectedHistoricalRate = item.marketRateStatistics?.selectedRate;
    const historicalRateStale = selectedHistoricalRate !== undefined &&
      Math.abs(selectedHistoricalRate - trace.historicalUnitRate) >= 0.005;
    if (historicalRateStale) {
      trace.historicalUnitRate = Math.round(selectedHistoricalRate * 100) / 100;
    }

    const rateUnchangedSinceBaseline = Math.abs(finalRate - trace.recommendedUnitRate) < 0.005 &&
      trace.explanation === trace.baselineExplanation;
    if (rateUnchangedSinceBaseline && !historicalRateStale) return;

    // The stage narratives below are the stages' OWN recorded reasoning - this engine
    // only assembles them, it never invents pricing rationale.
    const stageNarrative = item.isOverridden
      ? `Estimator override: rate manually set to ₹${finalRate.toFixed(2)}${trace.baselineExplanation ? "" : "."}`
      : item.calibrationApplied && item.calibrationReason
        ? item.calibrationReason
        : item.matchTier || item.engineeringAdjustment?.applied
          ? item.reason
          : item.reason;

    trace.recommendedUnitRate = Math.round(finalRate * 100) / 100;
    trace.explanation =
      `[${CommercialDecisionEngine.deriveRateProvenance(item)}] ${stageNarrative}` +
      (trace.baselineExplanation ? ` | Baseline stage: ${trace.baselineExplanation}` : "");
  }

  /**
   * Assemble and attach the immutable decision to the item. The two legitimate
   * call sites are the end of the recommendation pipeline and the estimator
   * override route.
   */
  static finalizeItemDecision(item: RFQItem): CommercialDecision {
    CommercialDecisionEngine.reconcileRecommendationTrace(item);
    const decision = CommercialDecisionEngine.deriveApprovalDecision(item);
    item.decision = decision;
    item.approvalStatus = decision.approvalStatus;
    return decision;
  }

  private static gradeEvidenceStrength(
    item: RFQItem,
    acceptedEvidenceCount: number
  ): CommercialDecision["evidenceStrength"] {
    const engineeringRefs = item.engineeringAdjustment?.applied
      ? item.engineeringAdjustment.historicalReferencesUsed.length
      : 0;
    const total = Math.max(acceptedEvidenceCount, engineeringRefs);
    if (total >= 4) return "Strong";
    if (total >= 2) return "Moderate";
    if (total >= 1) return "Weak";
    return "None";
  }

  /**
   * The one approval/accuracy formula (ADR-0001 merged the former 4-6 independent
   * variants). Every endpoint that reports buckets or an accuracy percentage -
   * per-RFQ auditor report, /api/analytics, /api/system-health, /api/rfqs
   * progress - calls this with its own item scope.
   */
  static computeApprovalMetrics(items: RFQItem[]): ApprovalMetrics {
    const counts = { pending: 0, autoApproved: 0, needsReview: 0, manualPricing: 0 };
    let overridden = 0;
    for (const item of items) {
      const status: ApprovalStatus = item.approvalStatus || "Pending";
      if (status === "Auto Approved") counts.autoApproved++;
      else if (status === "Needs Review") counts.needsReview++;
      else if (status === "Manual Pricing") counts.manualPricing++;
      else counts.pending++;
      if (item.isOverridden) overridden++;
    }
    const ratedItems = counts.autoApproved + counts.needsReview + counts.manualPricing;
    return {
      totalItems: items.length,
      ...counts,
      ratedItems,
      overridden,
      approvalAccuracy: ratedItems > 0 ? Math.round((counts.autoApproved / ratedItems) * 1000) / 10 : 100,
      nonOverrideRate: ratedItems > 0 ? Math.round(((ratedItems - overridden) / ratedItems) * 1000) / 10 : 100
    };
  }

  /**
   * Migrate a legacy persisted item (pre-ADR-0001 `status` vocabulary) in place.
   * Legacy "Accepted" maps to Auto Approved and "Needs Manual Review" to Needs
   * Review as a best-effort translation; the next recommendation run replaces the
   * mapping with a genuine CommercialDecision.
   */
  static migrateLegacyItem(item: RFQItem & { status?: string }): void {
    if (!item.approvalStatus) {
      item.approvalStatus =
        item.status === "Accepted"
          ? "Auto Approved"
          : item.status === "Needs Manual Review"
            ? "Needs Review"
            : "Pending";
    }
    delete item.status;
  }
}
