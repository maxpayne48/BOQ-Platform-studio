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
import {
  CONFIDENCE_APPROVAL_THRESHOLD,
  MIN_SELECTED_MATCH_SCORE_FOR_AUTO_RATE,
  MIN_PROJECT_SIMILARITY_FOR_AUTO_RATE,
  MIN_ENGINEERING_ADJUSTMENT_CONFIDENCE_FOR_AUTO_RATE
} from "./decisionConstants.js";

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

    // Evidence sufficiency (zero evidence, or evidence that exists but falls below the hard
    // confidence floor) - shared with finalizeItemDecision, which uses the same rule to decide
    // whether to clear item.recommendedRate before this decision is even built. See
    // evaluateEvidenceSufficiency's own comment for the full rationale.
    const sufficiency = CommercialDecisionEngine.evaluateEvidenceSufficiency(item);
    if (sufficiency.sufficient === false) {
      // item.recommendedRate has already been cleared to 0 by finalizeItemDecision, BEFORE trace
      // reconciliation ran, so build() below and the trace agree - see that function's comment.
      return build("Manual Pricing", sufficiency.reasonCode, sufficiency.summary, []);
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

  /**
   * The hard confidence floor (Part 2, 2026-07-27, "never fabricate, never guess, always flag").
   * Two independent gates, both routing to Manual Pricing with no fallback computation of any
   * kind (no domain average, no nearest-loose-match, no zero-in-name-only, no synthetic
   * constant):
   *
   * 1. Zero evidence of any kind - no master-catalog match, no relaxed-tier market estimate, no
   *    engineering dimensional model, no selected historical evidence. There is nothing behind
   *    the number.
   * 2. Evidence exists but falls below the minimum bar (MIN_SELECTED_MATCH_SCORE_FOR_AUTO_RATE /
   *    MIN_PROJECT_SIMILARITY_FOR_AUTO_RATE, src/decisionConstants.ts) - a STRICTER, EARLIER gate
   *    than CONFIDENCE_APPROVAL_THRESHOLD below, which decides Auto Approved vs. Needs Review for
   *    evidence that already cleared this floor; this gate decides whether there was ever enough
   *    real signal to price the item at all. Scoped to items whose FINAL rate is not still backed
   *    by an untouched exact match: `item.matchedMasterId` is written once, by the baseline stage,
   *    and is NEVER cleared even when a later stage (calibration/self-validation, Progressive
   *    Matching) completely replaces the rate with different, weaker evidence - confirmed live
   *    (2026-07-27 mechanism-verification pass, see docs/audit/0002-identity-and-evidence-
   *    integrity-audit.md "Follow-up Fix 6"): items with `calibrationApplied: true` and a
   *    `selectedMatchScore` as low as 53 still carried a stale `matchedMasterId` from their
   *    ORIGINAL baseline match, which a naive `!item.matchedMasterId` check would have wrongly
   *    read as "still strong" and exempted from this floor entirely - the floor would have been
   *    dead code. `matchedMasterId` is only trusted here when NOTHING downstream touched the
   *    rate (`!item.calibrationApplied && !item.matchTier`); the moment calibration or relaxed-
   *    tier matching takes over, this gate judges the ACTUAL evidence (`stats`) that is actually
   *    responsible for the number, regardless of what the stale field says.
   *
   * Shared by deriveApprovalDecision (which needs the reason text) and finalizeItemDecision
   * (which needs only the boolean, to clear item.recommendedRate before either this method or
   * trace reconciliation runs) - kept as one function so the two can never drift apart.
   */
  private static evaluateEvidenceSufficiency(
    item: RFQItem
  ): { sufficient: true } | { sufficient: false; reasonCode: DecisionReasonCode; summary: string } {
    if (item.isOverridden) return { sufficient: true };
    const stats = item.marketRateStatistics;

    const zeroEvidence =
      !item.matchedMasterId && !item.matchTier && !item.engineeringAdjustment?.applied && !stats;
    if (zeroEvidence) {
      return {
        sufficient: false,
        reasonCode: "NO_EVIDENCE",
        summary:
          "No commercially-equivalent historical evidence, engineering family, or relaxed-tier market estimate exists for this item. Manual pricing required."
      };
    }

    // Engineering-adjustment confidence floor (2026-07-29): when EngineeringAdjustmentEngine's own
    // interpolation/extrapolation is what the final rate actually rests on - true whenever it
    // `applied`, since ProjectCalibrationEngine.runProjectCalibration explicitly skips (never
    // overwrites) any item with `engineeringAdjustment.applied`, regardless of whether
    // marketRateStatistics also happens to exist for it - that adjustment's OWN reported confidence
    // must clear a floor too, the same way a statistical match must clear
    // MIN_SELECTED_MATCH_SCORE_FOR_AUTO_RATE below. Previously nothing checked this: a confidence-30
    // extrapolation (heavy extrapolation, thin reference set) was treated as fully sufficient just
    // because `applied === true`.
    if (
      item.engineeringAdjustment?.applied &&
      item.engineeringAdjustment.confidence < MIN_ENGINEERING_ADJUSTMENT_CONFIDENCE_FOR_AUTO_RATE
    ) {
      return {
        sufficient: false,
        reasonCode: "NO_EVIDENCE",
        summary:
          `Engineering dimensional adjustment confidence (${item.engineeringAdjustment.confidence}%) falls below ` +
          `the minimum ${MIN_ENGINEERING_ADJUSTMENT_CONFIDENCE_FOR_AUTO_RATE}% required to auto-price from a ` +
          `size/dimension interpolation alone - manual pricing required.`
      };
    }

    const rateStillBackedByUntouchedExactMatch =
      !!item.matchedMasterId && !item.calibrationApplied && !item.matchTier;
    const selectedEvidence = stats?.historicalEvidence?.find((e) => e.selected);
    const belowConfidenceFloor =
      !rateStillBackedByUntouchedExactMatch &&
      !!stats &&
      ((stats.selectedMatchScore ?? 0) < MIN_SELECTED_MATCH_SCORE_FOR_AUTO_RATE ||
        (selectedEvidence !== undefined && selectedEvidence.projectSimilarity < MIN_PROJECT_SIMILARITY_FOR_AUTO_RATE));
    if (belowConfidenceFloor) {
      return {
        sufficient: false,
        reasonCode: "NO_EVIDENCE",
        summary:
          `Selected evidence falls below the minimum confidence floor (match score ${stats!.selectedMatchScore}%` +
          (selectedEvidence ? `, source project similarity ${selectedEvidence.projectSimilarity}%` : "") +
          `) - minimums are ${MIN_SELECTED_MATCH_SCORE_FOR_AUTO_RATE}%/${MIN_PROJECT_SIMILARITY_FOR_AUTO_RATE}%. A low-confidence guess is not an acceptable substitute for real evidence - manual pricing required.`
      };
    }

    return { sufficient: true };
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
    // Clear a zero-evidence item's rate BEFORE trace reconciliation runs, not after, so the
    // trace's recommendedUnitRate/explanation and the decision's recommendedRate never disagree
    // (the same "single writer, reconciled once" principle reconcileRecommendationTrace's own
    // docstring establishes for the trace itself). item.recommendedRate at this point is still
    // whatever RecommendationEngineV2's Basic Rate baseline seeded it with - a synthetic domain-
    // cost-buildup on a flat ₹1000 placeholder, computed BEFORE this engine ever runs so
    // downstream evidence-based recalibration always had a starting number to potentially
    // improve on. When that recalibration never ran (zero evidence at every stage - no matched
    // master, no relaxed-tier match, no engineering model, no selected historical evidence), the
    // seed is all that's left, and per deriveApprovalDecision's own "there is nothing behind the
    // number" finding, it must not be exported/displayed as if it were a genuine recommendation.
    // Confirmed this is exactly how the ₹1,354.82 synthetic constant reached the exported Kohler
    // sheet for Signages/PHE/Passive Networking/FLSS Works/Toilet Works items - see
    // docs/audit/0002-identity-and-evidence-integrity-audit.md. The existing UI/export convention
    // for "no rate" (0 -> "-" in RecommendationsTab; falsy in export's `overriddenRate ||
    // recommendedRate` cell injection) already handles a cleared 0 correctly, no further changes
    // needed downstream.
    // Also covers the Part 2 confidence-floor case (evidence exists but is too weak to trust) -
    // see evaluateEvidenceSufficiency's own comment.
    // Gap F (2026-07-29): item.installationRate is computed earlier in the pipeline
    // (InstallationRateEngine.computeInstallationRate, server.ts) directly from whatever
    // item.recommendedRate held AT THAT TIME - a flat per-domain baseline percentage applied
    // unconditionally, never itself gated by this engine. When the supply rate is cleared below
    // for insufficient evidence, the installation rate derived from it is now stale (a confident-
    // looking non-zero number for an item that has otherwise been correctly flagged Manual
    // Pricing) and must be cleared alongside it - previously only the export route re-gated this
    // specific field at write time, leaving the live item/API JSON showing a number nothing backs.
    if (!CommercialDecisionEngine.evaluateEvidenceSufficiency(item).sufficient) {
      item.recommendedRate = 0;
      item.installationRate = undefined;
      item.installationPercentage = undefined;
      item.installationSource = undefined;
    }

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
