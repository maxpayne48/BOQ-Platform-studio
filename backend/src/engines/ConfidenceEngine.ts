/**
 * ConfidenceEngine (implemented — revised to the precise 5-factor spec)
 *
 * Evaluates the reliability of an *already selected* recommendation. It never recommends
 * a rate itself and never modifies the recommendation it is scoring - RecommendationEngineV2
 * (frozen) owns that decision entirely; this engine only reports how much to trust it.
 *
 * Pure and stateless - no persistence, no I/O, no dependency on any other engine.
 *
 * Compatibility note: RecommendationEngineV2.ts is frozen and already calls
 * `computeConfidence(...)` for real, reading `.score` and `.explanation` off the result and
 * constructing `ConfidenceFactors` with exactly {matchType, matchScore, projectSimilarityScore,
 * candidateCount, uomCompatible, uomConversionApplied} (verified by inspection before this
 * revision). The new confidenceScore/confidenceLevel/confidenceBreakdown/warnings shape is
 * therefore the primary contract going forward, with `score`/`band`/`explanation`/
 * `contributingFactors` kept as populated legacy-aliased fields so that frozen caller keeps
 * compiling and behaving identically without being touched. The two new input signals
 * (historicalRateAvailable, basicRateAvailable) are optional for the same reason - the
 * frozen caller's object literal does not supply them.
 */

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

export type ConfidenceMatchType =
  | "EXACT_MATCH"
  | "SPECIFICATION_MATCH"
  | "MATERIAL_MATCH"
  | "PARTIAL_MATCH"
  | "BASIC_RATE"
  | "NO_MATCH";

export type ConfidenceLevel = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";

export interface ConfidenceFactors {
  /** Match Type. */
  matchType: ConfidenceMatchType;
  /** Engineering Attribute Match - 0-100 retrieval relevance score from HistoricalRateEngine/BasicRateEngine. */
  matchScore?: number;
  /** Project Similarity Score - 0-100 from ProjectSimilarityEngine. Omitted (not just zero) when
   *  not applicable, e.g. for a Basic Rate recommendation - its weight is then redistributed
   *  across the other four factors rather than penalizing the score for a structural non-fit. */
  projectSimilarityScore?: number;
  /** UOM Compatibility, from UOMEngine. */
  uomCompatible: boolean;
  uomConversionApplied: boolean;
  /** Historical Rate Availability. Inferred from matchType when omitted. */
  historicalRateAvailable?: boolean;
  /** Basic Rate Availability. Inferred from matchType when omitted. */
  basicRateAvailable?: boolean;
  /** How many corroborating historical candidates were found - feeds Historical Data Quality. */
  candidateCount?: number;
}

export interface ConfidenceBreakdown {
  engineeringMatch: number;
  projectSimilarity: number;
  uomCompatibility: number;
  historicalDataQuality: number;
  dataCompleteness: number;
}

export interface ConfidenceResult {
  confidenceScore: number; // 0-100
  confidenceLevel: ConfidenceLevel;
  confidenceBreakdown: ConfidenceBreakdown;
  warnings: string[];

  /** @deprecated Legacy alias for confidenceScore, kept only so the already-frozen
   *  RecommendationEngineV2 (which reads `.score` directly) keeps working unchanged. */
  score: number;
  /** @deprecated Legacy 3-band alias, unused by the frozen caller but kept for shape stability. */
  band: "high" | "medium" | "low";
  /** @deprecated Legacy alias for a human-readable summary, kept only because the frozen
   *  RecommendationEngineV2 reads `.explanation` directly. */
  explanation: string;
  /** @deprecated Legacy alias for confidenceBreakdown. */
  contributingFactors: Record<string, number>;
}

export interface ConfidenceThresholds {
  veryHighMin: number;
  highMin: number;
  mediumMin: number;
  lowMin: number;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface IConfidenceEngine {
  computeConfidence(factors: ConfidenceFactors): ConfidenceResult;
  getThresholds(): ConfidenceThresholds;
  setThresholds(thresholds: ConfidenceThresholds): void;
}

// ---------------------------------------------------------------------------
// Confidence factor weights (sum to 100%)
// ---------------------------------------------------------------------------

const WEIGHTS = {
  engineeringMatch: 0.4,
  projectSimilarity: 0.3,
  uomCompatibility: 0.15,
  historicalDataQuality: 0.1,
  dataCompleteness: 0.05
} as const;

const DEFAULT_THRESHOLDS: ConfidenceThresholds = {
  veryHighMin: 95,
  highMin: 85,
  mediumMin: 70,
  lowMin: 50
};

/** 0-100 baseline per match tier, blended with the raw Engineering Attribute Match score
 *  (matchScore) when one is supplied - a tier alone never fully determines the component. */
const MATCH_TYPE_BASELINE: Record<ConfidenceMatchType, number> = {
  EXACT_MATCH: 100,
  SPECIFICATION_MATCH: 80,
  MATERIAL_MATCH: 55,
  BASIC_RATE: 45,
  PARTIAL_MATCH: 25,
  NO_MATCH: 0
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ConfidenceEngine implements IConfidenceEngine {
  private thresholds: ConfidenceThresholds;

  constructor(thresholds: ConfidenceThresholds = DEFAULT_THRESHOLDS) {
    this.thresholds = thresholds;
  }

  getThresholds(): ConfidenceThresholds {
    return { ...this.thresholds };
  }

  setThresholds(thresholds: ConfidenceThresholds): void {
    this.thresholds = thresholds;
  }

  computeConfidence(factors: ConfidenceFactors): ConfidenceResult {
    const historicalAvailable = this.resolveHistoricalRateAvailable(factors);
    const basicAvailable = this.resolveBasicRateAvailable(factors);

    const engineeringMatch = this.engineeringMatchComponent(factors);
    const uomCompatibility = this.uomCompatibilityComponent(factors);
    const historicalDataQuality = this.historicalDataQualityComponent(factors, historicalAvailable);
    const dataCompleteness = this.dataCompletenessComponent(historicalAvailable, basicAvailable);

    // Project Similarity is only applicable when a similarity score actually exists (i.e. a
    // historical-project-backed recommendation) - when it doesn't (e.g. a Basic Rate
    // recommendation), its weight is redistributed across the other four factors instead of
    // silently scoring it as 0, which would penalize a structurally inapplicable case.
    const projectSimilarityApplicable = factors.projectSimilarityScore !== undefined;
    const projectSimilarity = projectSimilarityApplicable ? factors.projectSimilarityScore! : 0;

    const weightedTerms = [
      { value: engineeringMatch, weight: WEIGHTS.engineeringMatch, applicable: true },
      { value: projectSimilarity, weight: WEIGHTS.projectSimilarity, applicable: projectSimilarityApplicable },
      { value: uomCompatibility, weight: WEIGHTS.uomCompatibility, applicable: true },
      { value: historicalDataQuality, weight: WEIGHTS.historicalDataQuality, applicable: true },
      { value: dataCompleteness, weight: WEIGHTS.dataCompleteness, applicable: true }
    ];

    const applicable = weightedTerms.filter((t) => t.applicable);
    const totalWeight = applicable.reduce((sum, t) => sum + t.weight, 0);
    const weightedSum = applicable.reduce((sum, t) => sum + t.value * t.weight, 0);
    const confidenceScore = totalWeight > 0 ? Math.max(0, Math.min(100, Math.round(weightedSum / totalWeight))) : 0;

    const confidenceBreakdown: ConfidenceBreakdown = {
      engineeringMatch: Math.round(engineeringMatch),
      projectSimilarity: Math.round(projectSimilarity),
      uomCompatibility: Math.round(uomCompatibility),
      historicalDataQuality: Math.round(historicalDataQuality),
      dataCompleteness: Math.round(dataCompleteness)
    };

    const confidenceLevel = this.classifyLevel(confidenceScore);
    const warnings = this.buildWarnings(factors, historicalAvailable, basicAvailable);

    const explanation =
      `Confidence ${confidenceScore}/100 (${confidenceLevel}): engineering match ${confidenceBreakdown.engineeringMatch}, ` +
      `project similarity ${projectSimilarityApplicable ? confidenceBreakdown.projectSimilarity : "n/a"}, ` +
      `UOM ${confidenceBreakdown.uomCompatibility}, historical data quality ${confidenceBreakdown.historicalDataQuality}, ` +
      `data completeness ${confidenceBreakdown.dataCompleteness}.`;

    const legacyBand: "high" | "medium" | "low" =
      confidenceScore >= this.thresholds.highMin ? "high" : confidenceScore >= this.thresholds.lowMin ? "medium" : "low";

    return {
      confidenceScore,
      confidenceLevel,
      confidenceBreakdown,
      warnings,
      score: confidenceScore,
      band: legacyBand,
      explanation,
      contributingFactors: { ...confidenceBreakdown }
    };
  }

  // --- Component calculations -------------------------------------------------

  private engineeringMatchComponent(factors: ConfidenceFactors): number {
    const baseline = MATCH_TYPE_BASELINE[factors.matchType] ?? 0;
    if (factors.matchScore === undefined) return baseline;
    return (baseline + factors.matchScore) / 2;
  }

  private uomCompatibilityComponent(factors: ConfidenceFactors): number {
    if (!factors.uomCompatible) return 0;
    return factors.uomConversionApplied ? 85 : 100;
  }

  private resolveHistoricalRateAvailable(factors: ConfidenceFactors): boolean {
    if (factors.historicalRateAvailable !== undefined) return factors.historicalRateAvailable;
    return factors.matchType !== "NO_MATCH" && factors.matchType !== "BASIC_RATE";
  }

  private resolveBasicRateAvailable(factors: ConfidenceFactors): boolean {
    if (factors.basicRateAvailable !== undefined) return factors.basicRateAvailable;
    return factors.matchType === "BASIC_RATE";
  }

  private historicalDataQualityComponent(factors: ConfidenceFactors, historicalAvailable: boolean): number {
    if (!historicalAvailable) return 0;
    const candidateCount = factors.candidateCount ?? 1;
    return Math.min(100, 50 + Math.max(0, candidateCount - 1) * 15);
  }

  private dataCompletenessComponent(historicalAvailable: boolean, basicAvailable: boolean): number {
    const count = (historicalAvailable ? 1 : 0) + (basicAvailable ? 1 : 0);
    return (count / 2) * 100;
  }

  private classifyLevel(score: number): ConfidenceLevel {
    if (score >= this.thresholds.veryHighMin) return "VERY_HIGH";
    if (score >= this.thresholds.highMin) return "HIGH";
    if (score >= this.thresholds.mediumMin) return "MEDIUM";
    if (score >= this.thresholds.lowMin) return "LOW";
    return "VERY_LOW";
  }

  // --- Warnings (informational only - never alters the recommendation) --------

  private buildWarnings(factors: ConfidenceFactors, historicalAvailable: boolean, basicAvailable: boolean): string[] {
    const warnings: string[] = [];

    if (!factors.uomCompatible) {
      warnings.push("UOM is incompatible between the RFQ item and the matched rate - verify units manually.");
    } else if (factors.uomConversionApplied) {
      warnings.push("A UOM conversion was applied - verify the converted quantity/rate before accepting.");
    }

    if (factors.matchType === "PARTIAL_MATCH") {
      warnings.push("Only a partial engineering attribute match was found (brand/execution/UOM overlap only) - material was not confirmed.");
    } else if (factors.matchType === "MATERIAL_MATCH") {
      warnings.push("Only the material matched - specification, grade, and dimensions were not confirmed.");
    } else if (factors.matchType === "SPECIFICATION_MATCH") {
      warnings.push("Engineering specification differs slightly from the matched historical item.");
    }

    if (factors.matchType === "BASIC_RATE") {
      warnings.push("Recommendation is based on a Basic Rate, not a comparable historical project.");
    }

    if (factors.matchType === "NO_MATCH" && !basicAvailable) {
      warnings.push("No historical or Basic Rate evidence is available for this item.");
    }

    if (historicalAvailable && (factors.candidateCount ?? 1) <= 1) {
      warnings.push("Only a single historical occurrence corroborates this rate.");
    }

    if (factors.projectSimilarityScore !== undefined && factors.projectSimilarityScore < 50) {
      warnings.push("The source project has low similarity to the current Project Profile.");
    }

    return warnings;
  }
}
