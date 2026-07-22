import { HistoricalBOQ, LearningEvent, MasterBOQItem, RFQItem } from "./types.js";
import { RecommendationEngineV2, ReplayRecord } from "./RecommendationEngineV2.js";
import { LearningEngine, LearningAnalysis } from "./LearningEngine.js";

// Project Calibration & Validation Layer ("the pricing engine") - runs strictly AFTER item
// matching, specification matching, UOM logic, historical candidate retrieval
// (src/HistoricalRetrievalEngine.ts), and engineering dimension adjustment are all complete.
// Never re-derives or overwrites those upstream results by itself.
//
// For every recommendation this computes a full Historical Market Distribution (min, max,
// median, weighted median, weighted mean, standard deviation, IQR, reference count) from that
// item's ranked historical candidates, using each candidate's similarity/match score as its
// weight - never a simple average. The "most representative market rate" is the WEIGHTED MEDIAN
// of that distribution rather than a single "best" historical rate or a weighted mean, so a small
// number of premium/luxury-project rates cannot dominate the recommendation regardless of how
// heavily they're weighted, and the estimate stabilizes (rather than swings) as more BOQs are
// added to the database.
//
// The objective is NOT to reproduce historical BOQs - historical replay accuracy is a validation
// metric, not the goal. The representativeRate above IS the final recommended rate for every item
// with genuine distributional evidence (>=2 outlier-cleaned references), replacing the raw
// single-match rate that the upstream matching engine proposed. This is universal, not a narrow
// correction gated behind project/domain deviation thresholds: an exact historical match is simply
// the strongest single input into the same distribution, so it naturally dominates the result
// without ever being blindly copied outright. Only two exceptions exist - an engineering
// dimensional model (Rule 7) or a human's explicit override - both cases where better evidence
// than a market average already exists. Project- and domain-level deviation are still computed and
// reported (Rules 2/3/6/9) purely as validation diagnostics.

const FALLBACK_PROJECT_WEIGHT = 0.35; // similarity weight used for historical rate references whose
// originating project isn't one of the current Top 5 similar projects - still counted (Rule 6:
// "consider all relevant projects with similarity-weighted influence"), just discounted.

const TOTAL_COST_DEVIATION_TARGET_PCT = 5; // Rule 10 - target for Total Project Cost Deviation
const DOMAIN_DEVIATION_TARGET_PP = 8; // Rule 10 - target for Domain Cost Deviation reporting

// --- Part A: Outlier Detection thresholds ---
const OLD_PROJECT_YEARS_THRESHOLD = 5; // a historical rate from a project older than this, relative
// to the current year, is stale market evidence ("Very Old Rates") and excluded before pricing.
const Z_SCORE_THRESHOLD = 3; // classic 3-sigma rule
const MODIFIED_Z_SCORE_THRESHOLD = 3.5; // MAD-based modified z-score, the standard Iglewicz &
// Hoaglin convention - more robust than a plain z-score since it's built on the median/MAD rather
// than the mean/stdDev, so it isn't itself distorted by the very outliers it's trying to catch.
const MIN_SAMPLE_FOR_STATISTICAL_TRIM = 4; // below this there isn't enough data to reliably call
// anything an "outlier" - IQR/Z-score/MAD would just be arbitrarily discarding scarce evidence.

// The Historical Market Distribution for a single recommendation - replaces the old "pick the
// Best Historical Rate" mental model entirely. Every recommendation with a matched master gets
// one of these, built from its ranked historical candidates (src/HistoricalRetrievalEngine.ts),
// using each candidate's similarity/match score as its weight - never a simple average.
export interface MarketRateStatistics {
  min: number;
  max: number;
  median: number;
  weightedMedian: number;
  weightedMean: number;
  standardDeviation: number;
  q1: number;
  q3: number;
  iqr: number;
  referenceCount: number;
  representativeRate: number;
  // Part A: Outlier Detection - how many raw historical references were excluded, and why,
  // before this distribution was computed. referenceCount above already reflects the cleaned set.
  outliersRemoved: number;
  outlierBreakdown: { reason: string; count: number }[];
  // Similarity-weighted average match score across the surviving candidates (0-100) - one of the
  // named inputs to Pricing Confidence below.
  averageSimilarityScore: number;
  // Learning Layer - a small, bounded nudge (see src/LearningEngine.ts) applied to
  // representativeRate above when estimators have a consistent, sufficiently-evidenced
  // correction history for this item/domain. null when no learned bias was available or
  // applicable - representativeRate is then the untouched statistical market rate.
  learningAdjustmentPercent: number | null;
  learningReason: string | null;
}

// Confidence Engine redesign - replaces the old single confidenceScore with six explicit,
// independently meaningful dimensions. Business logic, pricing logic (what rate gets
// recommended), and recommendation logic (item.status accept/review) are untouched - this is
// purely a richer confidence REPORT alongside them.
export interface ItemConfidenceProfile {
  semanticConfidence: number;
  specificationConfidence: number;
  pricingConfidence: number;
  engineeringConfidence: number;
  historicalConfidence: number;
  overallConfidence: number;
}

export interface DomainCostBreakdown {
  domain: string;
  estimatedCost: number;
  estimatedPercent: number;
  historicalPercent: number | null;
  deviationPp: number | null;
}

export interface ProjectValidationReport {
  expectedCost: number;
  expectedCostRangeLow: number;
  expectedCostRangeHigh: number;
  estimatedCostBeforeCalibration: number;
  estimatedCostAfterCalibration: number;
  differencePercentBeforeCalibration: number;
  differencePercentAfterCalibration: number;
  withinTargetAccuracy: boolean;
  domains: DomainCostBreakdown[];
  domainsCausingDeviation: string[];
  similarProjectsUsed: { projectName: string; cost: number; similarity: number }[];
  itemsRecalibrated: number;
}

export interface CalibrationOutcome {
  itemMarketStats: Map<string, MarketRateStatistics>;
  itemConfidences: Map<string, ItemConfidenceProfile>;
  validationReport: ProjectValidationReport;
}

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Standard weighted-median algorithm: sort by rate, walk cumulative weight until it crosses half
// of the total weight. Unlike a weighted MEAN, a handful of heavily-weighted premium/luxury rates
// can only shift this if they make up more than half the total weight - a small number of
// outliers, however large in value, cannot drag the result toward them. This is what makes the
// statistic resistant to premium/luxury domination, and also what keeps it stable as more BOQs
// are added: each new reference can only nudge the median, never swing it the way it could swing
// a small-sample mean.
function weightedMedian(pairs: { r: number; w: number }[]): number {
  const sorted = [...pairs].sort((a, b) => a.r - b.r);
  const totalWeight = sorted.reduce((s, p) => s + p.w, 0);
  if (totalWeight <= 0) {
    return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)].r : 0;
  }
  const half = totalWeight / 2;
  let cumulative = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i].w;
    if (cumulative >= half) {
      if (Math.abs(cumulative - half) < 1e-9 && i + 1 < sorted.length) {
        return (sorted[i].r + sorted[i + 1].r) / 2;
      }
      return sorted[i].r;
    }
  }
  return sorted[sorted.length - 1].r;
}

function weightedStandardDeviation(pairs: { r: number; w: number }[], weightedMean: number): number {
  const totalWeight = pairs.reduce((s, p) => s + p.w, 0);
  if (totalWeight <= 0) return 0;
  const variance = pairs.reduce((s, p) => s + p.w * Math.pow(p.r - weightedMean, 2), 0) / totalWeight;
  return Math.sqrt(variance);
}

function deriveGradeForOutlierCheck(projectName: string, projectType: string): "Premium" | "Standard" {
  // Same simple keyword convention used elsewhere in this codebase (RecommendationEngineV2's own
  // project-grade heuristic, and HistoricalRetrievalEngine's deriveProjectGrade) - kept as an
  // independent local copy here rather than a cross-file import so Outlier Detection never
  // depends on, or risks disturbing, those other engines.
  const text = `${projectName} ${projectType || ""}`.toLowerCase();
  if (text.includes("grade a") || text.includes("premium") || text.includes("luxury")) return "Premium";
  return "Standard";
}

interface OutlierCandidate {
  rate: number;
  weight: number;
  projectName: string;
}

// Part A: Outlier Detection. Runs BEFORE final pricing (before the Historical Market Distribution
// is built), removing:
//  - Incorrect Rates: non-finite / zero / negative values.
//  - Very Old Rates: from a project more than OLD_PROJECT_YEARS_THRESHOLD years old.
//  - Premium/Luxury Projects: a Grade A/Premium/Luxury reference is excluded ONLY when the
//    current target project is NOT itself Premium/Luxury - a premium project's own historical
//    data still legitimately prices against premium references, it's only distorting when it
//    leaks into a standard-grade estimate.
//  - Statistical Outliers: via IQR (Tukey fence), Z-score (3-sigma), and Median Absolute Deviation
//    (modified z-score) - a candidate is removed if ANY of the three methods flags it, but
//    statistical trimming is skipped entirely below MIN_SAMPLE_FOR_STATISTICAL_TRIM references,
//    and is never allowed to remove every remaining candidate.
function detectOutliers(
  candidates: OutlierCandidate[],
  currentGrade: string,
  projectByName: Map<string, HistoricalBOQ>,
  currentYear: number
): { survivors: OutlierCandidate[]; removed: { reason: string; count: number }[] } {
  const removalCounts = new Map<string, number>();
  const flag = (reason: string) => removalCounts.set(reason, (removalCounts.get(reason) || 0) + 1);
  const isCurrentPremium = currentGrade.toLowerCase().includes("premium") ||
    currentGrade.toLowerCase().includes("luxury") ||
    currentGrade.toLowerCase().includes("grade a");

  const stage1: OutlierCandidate[] = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.rate) || c.rate <= 0) {
      flag("Incorrect Rate");
      continue;
    }

    const project = projectByName.get(c.projectName);
    const year = project?.projectYear ? parseInt(project.projectYear, 10) : NaN;
    if (Number.isFinite(year) && currentYear - year > OLD_PROJECT_YEARS_THRESHOLD) {
      flag("Very Old Rate");
      continue;
    }

    const candidateGrade = deriveGradeForOutlierCheck(c.projectName, project?.projectType || "");
    if (candidateGrade === "Premium" && !isCurrentPremium) {
      flag("Premium/Luxury Project");
      continue;
    }

    stage1.push(c);
  }

  if (stage1.length < MIN_SAMPLE_FOR_STATISTICAL_TRIM) {
    return { survivors: stage1, removed: Array.from(removalCounts.entries()).map(([reason, count]) => ({ reason, count })) };
  }

  const rates = stage1.map((c) => c.rate);
  const sorted = [...rates].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const fenceLow = q1 - 1.5 * iqr;
  const fenceHigh = q3 + 1.5 * iqr;

  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const variance = rates.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / rates.length;
  const stdDev = Math.sqrt(variance);

  const medianRate = percentile(sorted, 0.5);
  const absDeviations = rates.map((r) => Math.abs(r - medianRate)).sort((a, b) => a - b);
  const mad = percentile(absDeviations, 0.5);

  const stage2: OutlierCandidate[] = [];
  for (const c of stage1) {
    const outsideIqr = iqr > 0 && (c.rate < fenceLow || c.rate > fenceHigh);
    const zScore = stdDev > 0 ? Math.abs((c.rate - mean) / stdDev) : 0;
    const outsideZ = zScore > Z_SCORE_THRESHOLD;
    const modifiedZ = mad > 0 ? Math.abs((0.6745 * (c.rate - medianRate)) / mad) : 0;
    const outsideMad = modifiedZ > MODIFIED_Z_SCORE_THRESHOLD;

    if (outsideIqr || outsideZ || outsideMad) {
      const reason = outsideIqr ? "Statistical Outlier (IQR)" : outsideZ ? "Statistical Outlier (Z-score)" : "Statistical Outlier (MAD)";
      flag(reason);
      continue;
    }
    stage2.push(c);
  }

  // Never let statistical trimming remove every remaining reference - if it would, keep the
  // pre-trim set instead of returning an empty distribution.
  const survivors = stage2.length > 0 ? stage2 : stage1;
  if (survivors === stage1) {
    // Undo any Stage 2 removal counts since none were actually applied.
    removalCounts.delete("Statistical Outlier (IQR)");
    removalCounts.delete("Statistical Outlier (Z-score)");
    removalCounts.delete("Statistical Outlier (MAD)");
  }

  return { survivors, removed: Array.from(removalCounts.entries()).map(([reason, count]) => ({ reason, count })) };
}

function computeMarketRateStatistics(
  matchedMaster: MasterBOQItem | undefined,
  similarityByProjectName: Map<string, number>,
  historicalCandidates: { rate: number; overallMatchScore: number; projectName: string }[] | undefined,
  currentGrade: string,
  projectByName: Map<string, HistoricalBOQ>,
  currentYear: number,
  domain: string,
  learningAnalysis: LearningAnalysis
): MarketRateStatistics | null {
  // Historical Retrieval redesign: when the new filtered/scored/ranked candidate list is
  // available (src/HistoricalRetrievalEngine.ts), it is the market-rate evidence used here -
  // each candidate already passed Domain/Item Family/UOM filtering and carries a proper
  // multi-factor match score, which is a strictly better weight than the old "similarity of the
  // originating project only" approach. Falls back to the matched master's raw historicalRates
  // (the previous behavior) only if retrieval produced nothing, so this never regresses to "no
  // statistics at all" for an item that still has a matched master.
  const useCandidates = historicalCandidates && historicalCandidates.length > 0;

  let rawCandidates: OutlierCandidate[];

  if (useCandidates) {
    rawCandidates = historicalCandidates!
      .filter((c) => Number.isFinite(c.rate) && c.rate > 0)
      .map((c) => ({ rate: c.rate, weight: Math.max(0.05, c.overallMatchScore / 100), projectName: c.projectName }));
  } else {
    if (!matchedMaster || !matchedMaster.historicalRates || matchedMaster.historicalRates.length === 0) {
      return null;
    }
    const projectsForRates = matchedMaster.projects || [];
    rawCandidates = matchedMaster.historicalRates
      .filter((r) => Number.isFinite(r) && r > 0)
      .map((r, i) => {
        const pname = projectsForRates[i];
        return {
          rate: r,
          weight: pname && similarityByProjectName.has(pname) ? (similarityByProjectName.get(pname) as number) : FALLBACK_PROJECT_WEIGHT,
          projectName: pname || "Unknown Project"
        };
      });
  }

  if (rawCandidates.length === 0) return null;

  // Part A: Outlier Detection - runs before final pricing, on whichever raw evidence set was
  // assembled above (ranked candidates when available, the matched master's own historical rates
  // otherwise).
  const { survivors, removed } = detectOutliers(rawCandidates, currentGrade, projectByName, currentYear);
  if (survivors.length === 0) return null;

  const rates = survivors.map((s) => s.rate);
  const weights = survivors.map((s) => s.weight);
  const pairs = rates.map((r, i) => ({ r, w: weights[i] }));
  const sorted = [...rates].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;

  const totalWeight = weights.reduce((s, w) => s + w, 0) || rates.length;
  const weightedMean = rates.reduce((s, r, i) => s + r * weights[i], 0) / totalWeight;
  const weightedMedianRate = weightedMedian(pairs);
  const standardDeviation = weightedStandardDeviation(pairs, weightedMean);

  // "Recommend the statistically most representative market rate" - the weighted median, not the
  // weighted mean, is used as the representative rate precisely so premium/luxury outliers (which
  // pull a mean upward regardless of how few of them there are) cannot dominate the recommendation.
  //
  // Learning Layer: on top of that statistical rate, gradually incorporate any consistent,
  // sufficiently-evidenced estimator correction history for this exact item or its domain - a
  // small, bounded nudge (+-10% max, scaled down further when evidence is thin), never a
  // replacement for the market-rate statistic itself.
  const learnedBias = LearningEngine.getLearnedBiasAdjustment(domain, matchedMaster?.id, learningAnalysis);
  const representativeRate = weightedMedianRate * (1 + learnedBias.adjustmentFactor);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median,
    weightedMedian: Math.round(weightedMedianRate * 100) / 100,
    weightedMean: Math.round(weightedMean * 100) / 100,
    standardDeviation: Math.round(standardDeviation * 100) / 100,
    q1,
    q3,
    iqr,
    referenceCount: rates.length,
    representativeRate: Math.round(representativeRate * 100) / 100,
    outliersRemoved: removed.reduce((s, r) => s + r.count, 0),
    outlierBreakdown: removed,
    averageSimilarityScore: Math.round(weights.reduce((s, w) => s + w, 0) / weights.length * 100),
    learningAdjustmentPercent: learnedBias.reason ? Math.round(learnedBias.adjustmentFactor * 1000) / 10 : null,
    learningReason: learnedBias.reason
  };
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Confidence Engine redesign. Six independent dimensions, each answering a different question:
//   Semantic       - does the historical item's DESCRIPTION genuinely match this RFQ item?
//   Specification  - does its SPECIFICATION/MATERIAL genuinely match (from the ranked
//                    candidates' own per-candidate specification/material similarity scores)?
//   Engineering    - if a dimensional model was used to adjust for a different size, how much
//                    trust does that specific mathematical adjustment deserve?
//   Historical     - how much evidence backs this recommendation, and how clean is it (reference
//                    count, how much outlier removal was needed, how similar the source projects
//                    were)?
//   Pricing        - given ALL of that evidence, how confident are we in the recommended rate
//                    itself - explicitly a function of reference count, historical variance,
//                    distribution stability, similarity scores, and engineering adjustment
//                    magnitude, per the redesign spec.
//   Overall        - a single weighted roll-up of the five, for at-a-glance triage.
function computeItemConfidenceProfile(
  item: RFQItem,
  marketStats: MarketRateStatistics | null,
  rateSource: string | undefined
): ItemConfidenceProfile {
  const semanticConfidence = rateSource === "Historical Rate" ? 99 : item.matchedMasterId ? 75 : 45;

  const specificationCandidateScores = (item.historicalCandidates || []).map((c) => c.scores.specification);
  let specificationConfidence: number;
  if (specificationCandidateScores.length > 0) {
    specificationConfidence = clampConfidence(
      specificationCandidateScores.reduce((s, v) => s + v, 0) / specificationCandidateScores.length
    );
  } else if (item.engineeringAdjustment?.applied) {
    specificationConfidence = clampConfidence(item.engineeringAdjustment.confidence);
  } else if (item.matchedMasterId) {
    specificationConfidence = clampConfidence(55 + (marketStats?.referenceCount || 0) * 5);
  } else {
    specificationConfidence = 40;
  }

  // Engineering Confidence: no dimensional model was needed at all -> full confidence. Where one
  // was applied, trust it in proportion to its OWN reported confidence (already accounts for
  // interpolation-vs-extrapolation and family reference count in EngineeringAdjustmentEngine).
  const engineeringConfidence = item.engineeringAdjustment?.applied
    ? clampConfidence(item.engineeringAdjustment.confidence)
    : 100;

  // Historical Confidence: trust in the EVIDENCE BASE itself - more references and higher source
  // similarity raise it; needing to strip out a lot of outliers lowers it. A Learning Layer
  // adjustment having been necessary at all is itself a signal that the raw historical rate
  // wasn't fully trustworthy on its own, so it costs a small additional penalty here.
  let historicalConfidence: number;
  if (!marketStats || marketStats.referenceCount === 0) {
    historicalConfidence = 20;
  } else {
    const referenceCoverage = clampConfidence(30 + marketStats.referenceCount * 10);
    const outlierPenalty = Math.min(20, marketStats.outliersRemoved * 5);
    const learningPenalty = marketStats.learningAdjustmentPercent !== null ? Math.min(10, Math.abs(marketStats.learningAdjustmentPercent) * 1.5) : 0;
    historicalConfidence = clampConfidence(referenceCoverage * 0.7 + marketStats.averageSimilarityScore * 0.3 - outlierPenalty - learningPenalty);
  }

  // Pricing Confidence - explicitly the five named inputs from the redesign spec, never a simple
  // "does the current rate sit near the median" check.
  let pricingConfidence: number;
  if (!marketStats || marketStats.referenceCount === 0) {
    pricingConfidence = 30;
  } else {
    // 1. Number of Historical References - saturating, more references raise confidence.
    const referenceScore = clampConfidence(20 + marketStats.referenceCount * 13);

    // 2. Historical Variance - coefficient of variation (stdDev / mean); tighter spread = higher.
    const coefficientOfVariation = marketStats.weightedMean > 0 ? marketStats.standardDeviation / marketStats.weightedMean : 0;
    const varianceScore = clampConfidence(100 - coefficientOfVariation * 150);

    // 3. Distribution Stability - IQR relative to the median; a robust, outlier-resistant spread
    //    measure distinct from variance above.
    const relativeIqr = marketStats.median > 0 ? marketStats.iqr / marketStats.median : 0;
    const stabilityScore = clampConfidence(100 - relativeIqr * 100);

    // 4. Similarity Scores - the surviving candidates' own similarity-weighted match quality.
    const similarityScore = clampConfidence(marketStats.averageSimilarityScore);

    // 5. Engineering Adjustment Magnitude - larger dimensional adjustments (and extrapolation
    //    beyond the known reference range) introduce additional pricing uncertainty.
    const engineeringMagnitudePenalty = item.engineeringAdjustment?.applied
      ? Math.min(100, (item.engineeringAdjustment.rateVariationPercent || 0) * 1.5 + (item.engineeringAdjustment.isExtrapolation ? 20 : 0))
      : 0;
    const engineeringMagnitudeScore = clampConfidence(100 - engineeringMagnitudePenalty);

    pricingConfidence = clampConfidence(
      referenceScore * 0.25 +
      varianceScore * 0.2 +
      stabilityScore * 0.2 +
      similarityScore * 0.2 +
      engineeringMagnitudeScore * 0.15
    );
  }

  const overallConfidence = clampConfidence(
    semanticConfidence * 0.25 +
    specificationConfidence * 0.15 +
    pricingConfidence * 0.3 +
    engineeringConfidence * 0.15 +
    historicalConfidence * 0.15
  );

  return { semanticConfidence, specificationConfidence, pricingConfidence, engineeringConfidence, historicalConfidence, overallConfidence };
}

interface ProjectDomainCosts {
  total: number;
  byDomain: Record<string, number>;
}

// Performance: replayDatabase can grow to millions of rows as thousands of historical BOQs
// accumulate. Grouping it by projectUuid ONCE (single O(N) pass) and then looking up each Top 5
// project's rows directly avoids re-scanning the entire array once per project (previously
// O(topProjects x replayDatabase.length) - exactly the "brute-force comparison" pattern to avoid).
function indexReplayDatabaseByProject(replayDatabase: ReplayRecord[]): Map<string, ReplayRecord[]> {
  const byProject = new Map<string, ReplayRecord[]>();
  for (const r of replayDatabase) {
    if (!byProject.has(r.projectUuid)) byProject.set(r.projectUuid, []);
    byProject.get(r.projectUuid)!.push(r);
  }
  return byProject;
}

function computeProjectDomainCosts(
  projectId: string,
  replayByProject: Map<string, ReplayRecord[]>,
  masterItemIdIndex: Record<string, MasterBOQItem>,
  shouldSkipSheet: (sheetName: string) => boolean
): ProjectDomainCosts {
  let total = 0;
  const byDomain: Record<string, number> = {};
  const records = replayByProject.get(projectId) || [];
  for (const r of records) {
    if (shouldSkipSheet(r.worksheetName || "")) continue;
    const amount = r.amount || r.unitRate * r.quantity || 0;
    if (amount <= 0) continue;
    total += amount;
    const domain = (r.masterItemId && masterItemIdIndex[r.masterItemId]?.domain) || "Uncategorized";
    byDomain[domain] = (byDomain[domain] || 0) + amount;
  }
  return { total, byDomain };
}

interface ExpectedProjectProfile {
  expectedCost: number;
  expectedRangeLow: number;
  expectedRangeHigh: number;
  domainWeightedPercent: Record<string, number>;
  perProject: { projectName: string; similarity: number; cost: number }[];
}

function computeExpectedProjectProfile(
  similarProjects: { project: HistoricalBOQ; similarity: number }[],
  replayDatabase: ReplayRecord[],
  masterItemIdIndex: Record<string, MasterBOQItem>,
  shouldSkipSheet: (sheetName: string) => boolean
): ExpectedProjectProfile | null {
  const replayByProject = indexReplayDatabaseByProject(replayDatabase);
  const perProjectRaw = similarProjects.map((sp) => {
    const { total, byDomain } = computeProjectDomainCosts(sp.project.id, replayByProject, masterItemIdIndex, shouldSkipSheet);
    return { projectName: sp.project.projectName, similarity: sp.similarity, cost: total, byDomain };
  }).filter((p) => p.cost > 0);

  if (perProjectRaw.length === 0) return null;

  const totalWeight = perProjectRaw.reduce((s, p) => s + p.similarity, 0) || perProjectRaw.length;
  const expectedCost = perProjectRaw.reduce((s, p) => s + p.cost * p.similarity, 0) / totalWeight;

  const costs = perProjectRaw.map((p) => p.cost);
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  const variance = costs.reduce((s, c) => s + Math.pow(c - mean, 2), 0) / costs.length;
  const stdDev = Math.sqrt(variance);
  const expectedRangeLow = Math.max(0, expectedCost - stdDev);
  const expectedRangeHigh = expectedCost + stdDev;

  const domainWeightedPercent: Record<string, number> = {};
  for (const p of perProjectRaw) {
    const w = p.similarity / totalWeight;
    for (const [domain, cost] of Object.entries(p.byDomain)) {
      const pct = (cost / p.cost) * 100;
      domainWeightedPercent[domain] = (domainWeightedPercent[domain] || 0) + pct * w;
    }
  }

  return {
    expectedCost,
    expectedRangeLow,
    expectedRangeHigh,
    domainWeightedPercent,
    perProject: perProjectRaw.map((p) => ({ projectName: p.projectName, similarity: p.similarity, cost: p.cost }))
  };
}

export const ProjectCalibrationEngine = {
  runProjectCalibration(params: {
    items: RFQItem[];
    similarProjects: { project: HistoricalBOQ; similarity: number }[];
    masterItemIdIndex: Record<string, MasterBOQItem>;
    replayDatabase: ReplayRecord[];
    shouldSkipSheet: (sheetName: string) => boolean;
    historicalBOQs: HistoricalBOQ[];
    buildingGrade: string;
    learningEvents: LearningEvent[];
    city: string;
  }): CalibrationOutcome {
    const { items, similarProjects, masterItemIdIndex, replayDatabase, shouldSkipSheet, historicalBOQs, buildingGrade, learningEvents, city } = params;

    // Historical candidate rates (src/HistoricalRetrievalEngine.ts / MasterBOQItem.historicalRates)
    // are RAW, un-adjusted rates - the frozen upstream matching engine (RecommendationEngineV2)
    // applies this same location factor on top of the raw rate before ever setting
    // item.recommendedRate. Reusing it here (never modifying that engine) keeps the market-rate
    // distribution on the same footing as the rate it's replacing - otherwise a correct regional
    // uplift (e.g. Pune/Mumbai +12%) would be silently discarded every time this layer applies,
    // which is exactly what caused an observed regression (project cost deviation got WORSE, not
    // better, after broadening calibration) until this was caught and fixed.
    const locationFactor = RecommendationEngineV2.getLocationFactorForCity(city);

    const similarityByProjectName = new Map<string, number>();
    similarProjects.forEach((sp) => similarityByProjectName.set(sp.project.projectName, sp.similarity));

    // Part A: Outlier Detection needs each candidate's originating project's year/type, looked up
    // once here regardless of whether that project is in the current Top 5.
    const projectByName = new Map<string, HistoricalBOQ>();
    historicalBOQs.forEach((h) => projectByName.set(h.projectName, h));
    const currentYear = new Date().getFullYear();

    // Learning Layer: analyzed once per run (internally cached/memoized by event count - see
    // src/LearningEngine.ts), never re-scanned per item.
    const learningAnalysis = LearningEngine.getLearningAnalysis(learningEvents);

    const itemMarketStats = new Map<string, MarketRateStatistics>();
    const itemConfidences = new Map<string, ItemConfidenceProfile>();

    for (const item of items) {
      const matchedMaster = item.matchedMasterId ? masterItemIdIndex[item.matchedMasterId] : undefined;
      const stats = computeMarketRateStatistics(matchedMaster, similarityByProjectName, item.historicalCandidates, buildingGrade, projectByName, currentYear, item.domain, learningAnalysis);
      if (stats) itemMarketStats.set(item.id, stats);
      itemConfidences.set(item.id, computeItemConfidenceProfile(item, stats, item.recommendationTrace?.rateSource));
    }

    const domainCostBefore: Record<string, number> = {};
    let estimatedCostBefore = 0;
    for (const item of items) {
      const cost = (item.overriddenRate ?? item.recommendedRate ?? 0) * (item.quantity || 0);
      estimatedCostBefore += cost;
      domainCostBefore[item.domain] = (domainCostBefore[item.domain] || 0) + cost;
    }

    const expectedProfile = computeExpectedProjectProfile(similarProjects, replayDatabase, masterItemIdIndex, shouldSkipSheet);

    // Core philosophy: this engine answers "what is the statistically most probable market rate
    // for this item?", not "what historical rate should I copy?". So the Historical Market
    // Distribution's representativeRate (similarity-weighted, outlier-cleaned, learning-adjusted -
    // see computeMarketRateStatistics above) is now the PRIMARY final rate for every item that has
    // genuine distributional evidence, not a rare correction applied only to a narrow,
    // domain-flagged subset. An exact historical match is not exempted from this - it simply
    // becomes the strongest single input into the same distribution (almost always the
    // highest-similarity-weighted point), so it naturally dominates the resulting estimate without
    // ever being blindly copied outright. This is exactly why replay accuracy on historical BOQs
    // should emerge as a validation side-effect of good estimation, rather than existing as a
    // designed-in special case - the two remaining exclusions below are the only real exceptions,
    // both protecting evidence that is already better than a market average: an engineering
    // dimensional model (Rule 7), or a human's explicit override.
    let itemsRecalibrated = 0;
    for (const item of items) {
      if (item.engineeringAdjustment?.applied) continue;
      if (item.isOverridden) continue;

      const stats = itemMarketStats.get(item.id);
      if (!stats || stats.referenceCount < 2) continue; // no real distribution to draw from yet -
      // keep whatever the upstream matching/basic-rate engine already computed.

      // Raw distribution rate, brought onto the same footing as the rate it may replace by
      // applying the same location factor the frozen upstream engine itself would apply.
      const marketRate = stats.representativeRate * locationFactor;
      if (!Number.isFinite(marketRate) || marketRate <= 0) continue;

      const currentRate = item.recommendedRate;
      const changePercent = currentRate > 0 ? (Math.abs(marketRate - currentRate) / currentRate) * 100 : 100;
      if (changePercent < 0.5) continue; // negligible difference - avoid noisy no-op rewrites

      item.recommendedRate = Math.round(marketRate * 100) / 100;
      item.calibrationApplied = true;
      item.calibrationReason =
        `Final rate is the statistically most probable market rate - a similarity-weighted, ` +
        `outlier-cleaned distribution of ${stats.referenceCount} historical reference(s) ` +
        `(median ₹${stats.median.toFixed(2)}, weighted median ₹${stats.weightedMedian.toFixed(2)}), ` +
        `not a single copied historical rate. Adjusted from ₹${currentRate.toFixed(2)} to ₹${item.recommendedRate.toFixed(2)}.`;
      itemsRecalibrated++;
    }

    // Domain-Level Validation remains purely informational/diagnostic below (Rule 9/6) - it no
    // longer gates which items get the market-rate treatment above, since that is now universal.

    const domainCostAfter: Record<string, number> = {};
    let estimatedCostAfter = 0;
    for (const item of items) {
      const cost = (item.overriddenRate ?? item.recommendedRate ?? 0) * (item.quantity || 0);
      estimatedCostAfter += cost;
      domainCostAfter[item.domain] = (domainCostAfter[item.domain] || 0) + cost;
    }

    const allDomainKeysAfter = new Set([...Object.keys(domainCostAfter), ...(expectedProfile ? Object.keys(expectedProfile.domainWeightedPercent) : [])]);
    const domains: DomainCostBreakdown[] = Array.from(allDomainKeysAfter).map((domain) => {
      const estimatedPercent = estimatedCostAfter > 0 ? ((domainCostAfter[domain] || 0) / estimatedCostAfter) * 100 : 0;
      const historicalPercent = expectedProfile?.domainWeightedPercent[domain];
      const hasHistorical = historicalPercent !== undefined && historicalPercent !== null;
      return {
        domain,
        estimatedCost: Math.round(domainCostAfter[domain] || 0),
        estimatedPercent: Math.round(estimatedPercent * 10) / 10,
        historicalPercent: hasHistorical ? Math.round((historicalPercent as number) * 10) / 10 : null,
        deviationPp: hasHistorical ? Math.round((estimatedPercent - (historicalPercent as number)) * 10) / 10 : null
      };
    }).sort((a, b) => b.estimatedCost - a.estimatedCost);

    const domainsCausingDeviation = domains
      .filter((d) => d.deviationPp !== null && Math.abs(d.deviationPp as number) > DOMAIN_DEVIATION_TARGET_PP)
      .map((d) => d.domain);

    const differencePercentBefore = expectedProfile ? ((estimatedCostBefore - expectedProfile.expectedCost) / expectedProfile.expectedCost) * 100 : 0;
    const differencePercentAfter = expectedProfile ? ((estimatedCostAfter - expectedProfile.expectedCost) / expectedProfile.expectedCost) * 100 : 0;

    const validationReport: ProjectValidationReport = {
      expectedCost: Math.round(expectedProfile?.expectedCost || 0),
      expectedCostRangeLow: Math.round(expectedProfile?.expectedRangeLow || 0),
      expectedCostRangeHigh: Math.round(expectedProfile?.expectedRangeHigh || 0),
      estimatedCostBeforeCalibration: Math.round(estimatedCostBefore),
      estimatedCostAfterCalibration: Math.round(estimatedCostAfter),
      differencePercentBeforeCalibration: Math.round(differencePercentBefore * 10) / 10,
      differencePercentAfterCalibration: Math.round(differencePercentAfter * 10) / 10,
      withinTargetAccuracy: Math.abs(differencePercentAfter) <= TOTAL_COST_DEVIATION_TARGET_PCT,
      domains,
      domainsCausingDeviation,
      similarProjectsUsed: (expectedProfile?.perProject || []).map((p) => ({
        projectName: p.projectName,
        cost: Math.round(p.cost),
        similarity: Math.round(p.similarity * 100) / 100
      })),
      itemsRecalibrated
    };

    return { itemMarketStats, itemConfidences, validationReport };
  }
};
