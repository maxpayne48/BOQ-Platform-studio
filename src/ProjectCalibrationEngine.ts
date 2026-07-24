import { HistoricalBOQ, LearningEvent, MasterBOQItem, RFQItem } from "./types.js";
import { ReplayRecord } from "./RecommendationEngineV2.js";
import { LearningEngine, LearningAnalysis } from "./LearningEngine.js";

// Project Calibration Layer ("the pricing engine") - runs strictly AFTER item matching,
// specification matching, UOM logic, historical candidate retrieval
// (src/HistoricalRetrievalEngine.ts), and engineering dimension adjustment are all complete.
// Never re-derives or overwrites those upstream results by itself.
//
// This engine does NOT average, median, or otherwise statistically blend historical rates -
// historical BOQs are engineering evidence, not pricing data. For every recommendation it filters
// the ranked historical candidates (src/HistoricalRetrievalEngine.ts) down to commercially
// equivalent evidence, then SELECTS the single closest match (highest project x item x
// specification x confidence score, already computed upstream) and uses that rate directly -
// unblended. Other equivalent evidence is retained only as corroboration (its COUNT strengthens
// confidence; its VALUES are never combined with the selected rate) and for explainability -
// "why this rate, why these historical items, why discarded."
//
// The objective is NOT to reproduce historical BOQs - historical replay accuracy is a validation
// side-effect, not the goal. When a genuine historical-BOQ twin exists, it naturally ranks highest
// and gets selected on its own merits - never via any code path that detects "is this a replay."
// The selectedRate above IS the final recommended rate for every item with genuine evidence,
// replacing the raw baseline the upstream matching engine proposed. Only two exceptions exist - an
// engineering dimensional model (a genuine size/dimension difference, handled separately by
// EngineeringAdjustmentEngine) or a human's explicit override - both cases where better evidence
// than a single historical match already exists. Project- and domain-level deviation are still
// computed and reported purely as validation diagnostics, never as inputs to pricing.
// (Interface name `MarketRateStatistics` and field name `representativeRate` are kept for minimal
// churn across call sites, even though nothing in this file is a statistic any more.)

const TOTAL_COST_DEVIATION_TARGET_PCT = 5; // Rule 10 - target for Total Project Cost Deviation
const DOMAIN_DEVIATION_TARGET_PP = 8; // Rule 10 - target for Domain Cost Deviation reporting

// --- Evidence pre-filters (Step 3: filter, never average) ---
const OLD_PROJECT_YEARS_THRESHOLD = 5; // a historical rate from a project older than this, relative
// to the current year, is stale market evidence ("Very Old Rates") and excluded before selection.

// The Historical Evidence outcome for a single recommendation - replaces the old "statistical
// distribution" mental model entirely. Built from an item's ranked, commercially-equivalent
// historical candidates (src/HistoricalRetrievalEngine.ts); selects the single closest match
// rather than blending multiple rates together.
export interface MarketRateStatistics {
  min: number; // lowest rate among surviving evidence (the literal extreme observed, not an average)
  max: number; // highest rate among surviving evidence
  referenceCount: number; // how many commercially-equivalent historical observations survived filtering
  selectedRate: number; // the single closest-matching historical observation's rate, unblended
  representativeRate: number; // selectedRate with the Learning Layer's bounded nudge applied (see below)
  // How many OTHER surviving observations corroborate the selection (commercially equivalent,
  // price-consistent) - a count, not a statistic on the rate values themselves.
  corroboratingCount: number;
  // Percent difference between the selected rate and the next-best evidence's rate, if any exists -
  // a direct two-point comparison (not a distribution-wide computation), used as a confidence
  // signal: the closer the second-best evidence agrees, the more the pick is corroborated.
  secondBestRateDeviationPercent: number | null;
  // The selected evidence's own overallMatchScore (0-100, project x item x specification x
  // confidence) - how strong is the single best piece of evidence itself.
  selectedMatchScore: number;
  // Step 7 (Explainability) - how many raw historical references were excluded before selection,
  // and why. referenceCount above already reflects the surviving set.
  rejectedCount: number;
  rejectedBreakdown: { reason: string; count: number }[];
  // Learning Layer - a small, bounded nudge (see src/LearningEngine.ts) applied to selectedRate
  // above when estimators have a consistent, sufficiently-evidenced correction history for this
  // item/domain. null when no learned bias was available or applicable.
  learningAdjustmentPercent: number | null;
  learningReason: string | null;
  // Explainability (Step 4/7): one row per historical project that survived filtering - the
  // `selected` one is the actual source of the recommendation; the rest are shown as corroborating
  // evidence only, never blended into the rate.
  historicalEvidence: {
    projectName: string;
    projectSimilarity: number; // 0-100, Stage 1 project ranking score
    itemSimilarity: number;    // 0-100, item-level (semantic+material) match quality
    specificationSimilarity: number; // 0-100, independent specification match quality
    historicalRate: number;
    selected: boolean; // true for the single observation this recommendation was taken from
    corroborating: boolean; // true for other commercially-equivalent, price-consistent survivors
    section: string;      // worksheet/BOQ section this observation came from
    historicalDate: string; // originating project's year, "N/A" if unknown
  }[];
  // Step 7 - the historical items considered but discarded, and why (from both
  // HistoricalRetrievalEngine's gates and this engine's own pre-filters).
  rejectedEvidence: { standardDescription: string; projectName: string; reason: string }[];
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

// Task 6 (Domain Consistency) - the core Domain enum only has 4 buckets (Civil/Interior/
// Electrical/Mechanical), which hides quality differences between e.g. HVAC and Plumbing (both
// "Mechanical") or Furniture and generic Interior fit-out. This is purely a REPORTING label used
// only in the domain-cost-breakdown diagnostics below - it never touches pricing, outlier
// detection, getAdjustmentsForDomain, or the Domain enum itself, so recalibration behavior is
// unaffected. A fresh, minimal keyword list (not a reuse of InstallationRateEngine's own 17-
// category system, which is scoped to installation-percentage baselines, not domain reporting).
const SUBDOMAIN_KEYWORDS: { label: string; keywords: string[] }[] = [
  { label: "Fire Fighting", keywords: ["fire alarm", "fire fighting", "firefighting", "sprinkler", "hydrant", "fire pump", "smoke detector"] },
  { label: "HVAC", keywords: ["hvac", "ahu", "vrf", "vrv", "chiller", "fcu", "duct", "ducting"] },
  { label: "Plumbing", keywords: ["plumb", "sanitary", "pipe", "piping", "wash basin", "valve", "phe"] },
  { label: "Furniture", keywords: ["furniture", "workstation", "veneer", "laminate"] }
];

function deriveReportingDomain(domain: string, description: string): string {
  const text = (description || "").toLowerCase();
  for (const entry of SUBDOMAIN_KEYWORDS) {
    if (entry.keywords.some((k) => text.includes(k))) return entry.label;
  }
  return domain; // Civil / Interior / Electrical stay as-is; unclassified items keep their base domain label
}

function deriveGradeForEvidenceCheck(projectName: string, projectType: string): "Premium" | "Standard" {
  // Same simple keyword convention used elsewhere in this codebase (RecommendationEngineV2's own
  // project-grade heuristic, and HistoricalRetrievalEngine's deriveProjectGrade) - kept as an
  // independent local copy here rather than a cross-file import so evidence filtering never
  // depends on, or risks disturbing, those other engines.
  const text = `${projectName} ${projectType || ""}`.toLowerCase();
  if (text.includes("grade a") || text.includes("premium") || text.includes("luxury")) return "Premium";
  return "Standard";
}

interface EvidenceRecord {
  rate: number;
  weight: number; // overallMatchScore/100 from HistoricalRetrievalEngine - used for RANKING/
  // SELECTION only, never to weight-average multiple rates together.
  projectName: string;
  // Item-level match quality (0-100), independent of project similarity - carried through
  // filtering untouched so the surviving evidence can be grouped per-project for the
  // historicalEvidence explainability table below. Mirrors HistoricalRetrievalEngine's own
  // "Item Similarity" factor definition (semantic + material only - specification is now its own
  // separate factor, not folded in here, so the two numbers shown in Historical Evidence stay
  // non-redundant).
  itemSimilarity: number;
  // Step 4 (Historical Evidence): specification match quality, shown as its own evidence-record
  // field per the brief, rather than folded into itemSimilarity above.
  specificationSimilarity: number;
  // Step 4: which BOQ section/worksheet this observation came from (informational only).
  section: string;
}

// Mirrors HistoricalRetrievalEngine's "Item Similarity" factor (semantic*0.625 + material*0.375,
// the same 5:3 ratio the old additive weights .25/.15 had) - not a new metric, just applied here to
// build the per-project Historical Evidence rows with the identical definition used for weighting.
function computeItemSimilarity(scores: { semantic: number; material: number }): number {
  return Math.round(scores.semantic * 0.625 + scores.material * 0.375);
}

// Confidence/specification used for the historicalEvidence table when falling back to a matched
// master's raw historicalRates (no per-candidate score breakdown exists on that path) - matches
// the existing "matched to a known Master Catalog item" confidence convention used elsewhere in
// this codebase (RecommendationEngineV2's Basic Rate path uses the same 70 for an analogous "known
// match, no finer-grained score" situation).
const FALLBACK_ITEM_SIMILARITY = 70;

// Step 3 (Filter Historical Evidence) - runs BEFORE selection, discarding (never averaging away):
//  - Incorrect Rates: non-finite / zero / negative values.
//  - Very Old Rates: from a project more than OLD_PROJECT_YEARS_THRESHOLD years old (stale
//    commercial evidence).
//  - Premium/Luxury Projects: a Grade A/Premium/Luxury reference is excluded ONLY when the
//    current target project is NOT itself Premium/Luxury - a premium project's own historical
//    data still legitimately prices against premium references, it's only commercially
//    inconsistent when it leaks into a standard-grade estimate.
// No statistical outlier detection here (no IQR/Z-score/MAD) - there is no distribution to detect
// outliers from once the goal is selecting the single closest match, not blending a set of prices.
function filterHistoricalEvidence(
  candidates: EvidenceRecord[],
  currentGrade: string,
  projectByName: Map<string, HistoricalBOQ>,
  currentYear: number
): { survivors: EvidenceRecord[]; rejected: { reason: string; count: number }[] } {
  const rejectionCounts = new Map<string, number>();
  const flag = (reason: string) => rejectionCounts.set(reason, (rejectionCounts.get(reason) || 0) + 1);
  const isCurrentPremium = currentGrade.toLowerCase().includes("premium") ||
    currentGrade.toLowerCase().includes("luxury") ||
    currentGrade.toLowerCase().includes("grade a");

  const survivors: EvidenceRecord[] = [];
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

    const candidateGrade = deriveGradeForEvidenceCheck(c.projectName, project?.projectType || "");
    if (candidateGrade === "Premium" && !isCurrentPremium) {
      flag("Premium/Luxury Project");
      continue;
    }

    survivors.push(c);
  }

  return { survivors, rejected: Array.from(rejectionCounts.entries()).map(([reason, count]) => ({ reason, count })) };
}

function selectHistoricalEvidence(
  matchedMaster: MasterBOQItem | undefined,
  similarityByProjectName: Map<string, number>,
  historicalCandidates: {
    rate: number;
    overallMatchScore: number;
    projectName: string;
    scores?: { semantic: number; specification: number; material: number; dimension: number; engineering: number };
    section?: string;
  }[] | undefined,
  currentGrade: string,
  projectByName: Map<string, HistoricalBOQ>,
  currentYear: number,
  domain: string,
  learningAnalysis: LearningAnalysis
): MarketRateStatistics | null {
  // Historical Retrieval redesign: when the filtered/scored/ranked candidate list is available
  // (src/HistoricalRetrievalEngine.ts), it is the evidence pool used here - each candidate already
  // passed Domain/Item Family/UOM/Commercial-Equivalence filtering and carries a proper
  // multi-factor match score. Falls back to the matched master's raw historicalRates only if
  // retrieval produced nothing, so this never regresses to "no evidence at all" for an item that
  // still has a matched master.
  const useCandidates = historicalCandidates && historicalCandidates.length > 0;

  let rawCandidates: EvidenceRecord[];

  if (useCandidates) {
    rawCandidates = historicalCandidates!
      .filter((c) => Number.isFinite(c.rate) && c.rate > 0)
      .map((c) => ({
        rate: c.rate,
        weight: Math.max(0.05, c.overallMatchScore / 100),
        projectName: c.projectName,
        itemSimilarity: c.scores ? computeItemSimilarity(c.scores) : c.overallMatchScore,
        specificationSimilarity: c.scores ? c.scores.specification : c.overallMatchScore,
        section: c.section || "N/A"
      }));
  } else {
    if (!matchedMaster || !matchedMaster.historicalRates || matchedMaster.historicalRates.length === 0) {
      return null;
    }
    const projectsForRates = matchedMaster.projects || [];
    const worksheetsForRates = matchedMaster.historicalWorksheets || [];
    // Stage 2 boundary (Problem 2 fix): same as HistoricalRetrievalEngine - only rates from
    // projects inside the Stage 1 shortlist count as evidence here, never "anyone in the whole
    // catalog at a discount".
    rawCandidates = matchedMaster.historicalRates
      .map((r, i) => ({ rate: r, projectName: projectsForRates[i], section: worksheetsForRates[i] }))
      .filter((c) => Number.isFinite(c.rate) && c.rate > 0 && c.projectName && similarityByProjectName.has(c.projectName))
      .map((c) => ({
        rate: c.rate,
        weight: similarityByProjectName.get(c.projectName as string) as number,
        projectName: c.projectName as string,
        itemSimilarity: FALLBACK_ITEM_SIMILARITY,
        specificationSimilarity: FALLBACK_ITEM_SIMILARITY,
        section: c.section || "N/A"
      }));
  }

  if (rawCandidates.length === 0) return null;

  // Step 3 - filter (never average away) before selection.
  const { survivors, rejected } = filterHistoricalEvidence(rawCandidates, currentGrade, projectByName, currentYear);
  if (survivors.length === 0) return null;

  // Step 5/6 - SELECT the single closest commercial match; rank by the same overallMatchScore-
  // derived weight already computed upstream (project x item x specification x confidence) - never
  // a median/mean/weighted-average of the surviving rates.
  const ranked = [...survivors].sort((a, b) => b.weight - a.weight);
  const selected = ranked[0];
  const selectedRate = selected.rate;
  const secondBest = ranked.length > 1 ? ranked[1] : null;
  const secondBestRateDeviationPercent = secondBest && selectedRate > 0
    ? Math.round((Math.abs(secondBest.rate - selectedRate) / selectedRate) * 1000) / 10
    : null;

  const rates = survivors.map((s) => s.rate);
  const min = Math.min(...rates);
  const max = Math.max(...rates);

  // Learning Layer: on top of the selected historical observation, gradually incorporate any
  // consistent, sufficiently-evidenced estimator correction history for this exact item or its
  // domain - a small, bounded nudge (+-10% max, scaled down further when evidence is thin), never
  // a replacement for the selected rate itself.
  const learnedBias = LearningEngine.getLearnedBiasAdjustment(domain, matchedMaster?.id, learningAnalysis);
  const representativeRate = selectedRate * (1 + learnedBias.adjustmentFactor);

  // Explainability (Step 4/7): one row per historical project that survived filtering - never
  // blended. When a project has multiple surviving occurrences, its highest-ranked one represents
  // it (still no averaging within a project either).
  const bestPerProject = new Map<string, EvidenceRecord>();
  for (const s of survivors) {
    const existing = bestPerProject.get(s.projectName);
    if (!existing || s.weight > existing.weight) bestPerProject.set(s.projectName, s);
  }
  const historicalEvidence = Array.from(bestPerProject.entries())
    .map(([projectName, e]) => ({
      projectName,
      projectSimilarity: Math.round((similarityByProjectName.get(projectName) || 0) * 100),
      itemSimilarity: e.itemSimilarity,
      specificationSimilarity: e.specificationSimilarity,
      historicalRate: Math.round(e.rate * 100) / 100,
      selected: projectName === selected.projectName,
      corroborating: projectName !== selected.projectName,
      section: e.section,
      historicalDate: projectByName.get(projectName)?.projectYear || "N/A"
    }))
    .sort((a, b) => (b.selected ? 1 : 0) - (a.selected ? 1 : 0));

  return {
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    referenceCount: rates.length,
    selectedRate: Math.round(selectedRate * 100) / 100,
    representativeRate: Math.round(representativeRate * 100) / 100,
    corroboratingCount: historicalEvidence.filter((e) => e.corroborating).length,
    secondBestRateDeviationPercent,
    selectedMatchScore: Math.round(selected.weight * 100),
    rejectedCount: rejected.reduce((s, r) => s + r.count, 0),
    rejectedBreakdown: rejected,
    learningAdjustmentPercent: learnedBias.reason ? Math.round(learnedBias.adjustmentFactor * 1000) / 10 : null,
    learningReason: learnedBias.reason,
    historicalEvidence,
    rejectedEvidence: [] // merged in with HistoricalRetrievalEngine's own rejections by server.ts
  };
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Confidence Engine. Six independent dimensions, each answering a different question - none of
// them a statistic over multiple historical rates (no variance, no IQR, no coefficient of
// variation - those concepts don't exist in this engine any more):
//   Semantic       - does the historical item's DESCRIPTION genuinely match this RFQ item?
//   Specification  - does its SPECIFICATION/MATERIAL genuinely match (from the ranked
//                    candidates' own per-candidate specification/material similarity scores)?
//   Engineering    - if a dimensional model was used to adjust for a different size, how much
//                    trust does that specific mathematical adjustment deserve?
//   Historical     - how much evidence backs this recommendation, and how clean is it (reference
//                    count, how much evidence had to be rejected as commercially non-equivalent
//                    or stale)?
//   Pricing        - given the SELECTED evidence, how confident are we in the recommended rate -
//                    a function of reference count, the selected match's own quality, how many
//                    other observations corroborate it, how closely the second-best evidence
//                    agrees, and engineering adjustment magnitude.
//   Overall        - a single weighted roll-up of the five, for at-a-glance triage.
function computeItemConfidenceProfile(
  item: RFQItem,
  marketStats: MarketRateStatistics | null,
  rateSource: string | undefined
): ItemConfidenceProfile {
  const semanticConfidence = item.matchedMasterId ? 75 : 45;

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

  // Historical Confidence: trust in the EVIDENCE BASE itself - more surviving references and a
  // stronger selected match raise it; needing to reject a lot of evidence as commercially non-
  // equivalent or stale lowers it. A Learning Layer adjustment having been necessary at all is
  // itself a signal the raw selected rate wasn't fully trustworthy on its own, so it costs a small
  // additional penalty here.
  let historicalConfidence: number;
  if (!marketStats || marketStats.referenceCount === 0) {
    historicalConfidence = 20;
  } else {
    const referenceCoverage = clampConfidence(30 + marketStats.referenceCount * 10);
    const rejectionPenalty = Math.min(20, marketStats.rejectedCount * 5);
    const learningPenalty = marketStats.learningAdjustmentPercent !== null ? Math.min(10, Math.abs(marketStats.learningAdjustmentPercent) * 1.5) : 0;
    historicalConfidence = clampConfidence(referenceCoverage * 0.7 + marketStats.selectedMatchScore * 0.3 - rejectionPenalty - learningPenalty);
  }

  // Pricing Confidence - a function of the SELECTED evidence's quality and how well it's
  // corroborated, never a "how tight is the spread of all historical rates" statistic.
  let pricingConfidence: number;
  if (!marketStats || marketStats.referenceCount === 0) {
    pricingConfidence = 30;
  } else {
    // 1. Number of Historical References - saturating, more surviving evidence raises confidence.
    const referenceScore = clampConfidence(20 + marketStats.referenceCount * 13);

    // 2. Corroboration Strength - how many OTHER commercially-equivalent observations agree with
    //    the selection (a count, not a statistic on the rate values themselves).
    const corroborationScore = clampConfidence(50 + marketStats.corroboratingCount * 15);

    // 3. Rate Consistency - how closely the second-best evidence's rate agrees with the selected
    //    one (a direct two-point comparison, not a distribution-wide spread measure). Neutral when
    //    there's no second observation to compare against.
    const consistencyScore = marketStats.secondBestRateDeviationPercent === null
      ? 70
      : clampConfidence(100 - marketStats.secondBestRateDeviationPercent * 2);

    // 4. Match Score - the selected evidence's own project x item x specification x confidence score.
    const matchScore = clampConfidence(marketStats.selectedMatchScore);

    // 5. Engineering Adjustment Magnitude - larger dimensional adjustments (and extrapolation
    //    beyond the known reference range) introduce additional pricing uncertainty.
    const engineeringMagnitudePenalty = item.engineeringAdjustment?.applied
      ? Math.min(100, (item.engineeringAdjustment.rateVariationPercent || 0) * 1.5 + (item.engineeringAdjustment.isExtrapolation ? 20 : 0))
      : 0;
    const engineeringMagnitudeScore = clampConfidence(100 - engineeringMagnitudePenalty);

    pricingConfidence = clampConfidence(
      referenceScore * 0.25 +
      corroborationScore * 0.2 +
      consistencyScore * 0.2 +
      matchScore * 0.2 +
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
    const baseDomain = (r.masterItemId && masterItemIdIndex[r.masterItemId]?.domain) || "Uncategorized";
    const domain = deriveReportingDomain(baseDomain, r.originalDescription);
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
  // Exposed for src/ProgressiveMatchingEngine.ts, which reuses this exact filter-then-select
  // evidence logic to price relaxed-tier candidate pools (Specification/Material/Functional match)
  // rather than re-implementing the same reasoning a third time.
  selectHistoricalEvidence,

  // Exposed for server.ts's Task 8 Self-Validation second pass, which needs to recompute an
  // item's confidence profile after adopting a better-evidenced re-evaluated rate (never touches
  // business/pricing logic itself - purely re-derives the same confidence report this engine
  // already computes for every item on the first pass).
  computeItemConfidenceProfile,

  runProjectCalibration(params: {
    items: RFQItem[];
    similarProjects: { project: HistoricalBOQ; similarity: number }[];
    masterItemIdIndex: Record<string, MasterBOQItem>;
    replayDatabase: ReplayRecord[];
    shouldSkipSheet: (sheetName: string) => boolean;
    historicalBOQs: HistoricalBOQ[];
    buildingGrade: string;
    learningEvents: LearningEvent[];
  }): CalibrationOutcome {
    const { items, similarProjects, masterItemIdIndex, replayDatabase, shouldSkipSheet, historicalBOQs, buildingGrade, learningEvents } = params;

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
      const stats = selectHistoricalEvidence(matchedMaster, similarityByProjectName, item.historicalCandidates, buildingGrade, projectByName, currentYear, item.domain, learningAnalysis);
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

    // Core philosophy: this engine answers "what is the closest, commercially-equivalent
    // historical evidence for this item?", never "what's the average/median historical rate?".
    // The selected evidence's representativeRate (the single closest match, with the Learning
    // Layer's bounded nudge applied - see selectHistoricalEvidence above) is now the PRIMARY final
    // rate for every item that has ANY surviving commercially-equivalent evidence - even just one
    // observation is legitimate evidence to select from ("no requirement to use all historical
    // observations"), not a rare correction applied only to a narrow, domain-flagged subset. An
    // exact historical match is not exempted from this - it simply IS the selected evidence
    // (almost always the highest-ranked one), so it naturally dominates the resulting estimate
    // without ever being blended with anything else. This is exactly why replay accuracy on
    // historical BOQs should emerge as a validation side-effect of good reasoning, rather than
    // existing as a designed-in special case - the two remaining exclusions below are the only
    // real exceptions, both protecting evidence that is already better than a single historical
    // match: an engineering dimensional model (a genuine size/dimension difference), or a human's
    // explicit override.
    let itemsRecalibrated = 0;
    for (const item of items) {
      if (item.engineeringAdjustment?.applied) continue;
      if (item.isOverridden) continue;

      const stats = itemMarketStats.get(item.id);
      if (!stats) continue; // no commercially-equivalent evidence survived filtering - keep
      // whatever the upstream matching/basic-rate engine already computed.

      // Historical rates are already real market rates - never city re-based (Problem 1), so the
      // selected evidence's representativeRate is used directly, with no location multiplier.
      const marketRate = stats.representativeRate;
      if (!Number.isFinite(marketRate) || marketRate <= 0) continue;

      const currentRate = item.recommendedRate;
      const changePercent = currentRate > 0 ? (Math.abs(marketRate - currentRate) / currentRate) * 100 : 100;
      if (changePercent < 0.5) continue; // negligible difference - avoid noisy no-op rewrites

      item.recommendedRate = Math.round(marketRate * 100) / 100;
      item.calibrationApplied = true;
      item.calibrationReason =
        `Final rate selected from the closest commercially-equivalent historical evidence ` +
        `(₹${stats.selectedRate.toFixed(2)}, match score ${stats.selectedMatchScore}%)` +
        `${stats.corroboratingCount > 0 ? `, corroborated by ${stats.corroboratingCount} other equivalent observation(s)` : ""} ` +
        `out of ${stats.referenceCount} historical reference(s) considered - never an average or blend. ` +
        `Adjusted from ₹${currentRate.toFixed(2)} to ₹${item.recommendedRate.toFixed(2)}.`;
      itemsRecalibrated++;
    }

    // Domain-Level Validation remains purely informational/diagnostic below (Rule 9/6) - it no
    // longer gates which items get the market-rate treatment above, since that is now universal.

    const domainCostAfter: Record<string, number> = {};
    let estimatedCostAfter = 0;
    for (const item of items) {
      const cost = (item.overriddenRate ?? item.recommendedRate ?? 0) * (item.quantity || 0);
      estimatedCostAfter += cost;
      const reportingDomain = deriveReportingDomain(item.domain, item.originalDescription);
      domainCostAfter[reportingDomain] = (domainCostAfter[reportingDomain] || 0) + cost;
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
