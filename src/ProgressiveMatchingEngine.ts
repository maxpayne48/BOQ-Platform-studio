import { HistoricalBOQ, MasterBOQItem, RFQItem } from "./types.js";
import { ProjectCalibrationEngine, MarketRateStatistics } from "./ProjectCalibrationEngine.js";
import { HistoricalRetrievalEngine } from "./HistoricalRetrievalEngine.js";
import { LearningAnalysis } from "./LearningEngine.js";
import { MIN_RELAXED_TIER_REFERENCES } from "./decisionConstants.js";

// Progressive Relaxation Matching - additive, only ever invoked for items that are genuinely
// stuck (no matched master item AND fewer than 2 candidates from HistoricalRetrievalEngine's own
// broad-but-gated retrieval). Never touches items that already have real evidence, and never
// re-derives or loosens HistoricalRetrievalEngine's own semantic/commercial-equivalence gates
// (raised 20 -> 45 earlier this session specifically to stop unrelated items polluting a price -
// loosening it back down for every item to help this small population would reintroduce that bug
// for everyone else).
//
// Instead this walks its own, independent, explicitly-labelled relaxation ladder - Specification
// Match -> Material Match -> Functional Match -> Manual Pricing - stopping at the first tier with
// enough (>=2) qualifying historical rates, and prices whichever tier
// qualifies using the exact same filter-then-select evidence reasoning already used for every
// other recommendation (ProjectCalibrationEngine.selectHistoricalEvidence - the single closest-
// matching observation within the tier, never an average), so a relaxed-tier estimate is held to
// the same reasoning standard, not a cruder guess.

export type MatchTier = "Specification Match" | "Material Match" | "Functional Match" | "Market Estimation" | "None";

export interface ProgressiveMatchResult {
  applied: boolean;
  finalRate: number;
  tier: MatchTier;
  referenceCount: number;
  marketStats: MarketRateStatistics | null;
  explanation: string;
}

// MIN_RELAXED_TIER_REFERENCES (src/decisionConstants.ts, part of the Part 2 confidence-floor
// audit) - these relaxed tiers use synthetic, not engineering-matched, scores - requiring 2+
// corroborating observations here (unlike the primary evidence path, which accepts a single
// strong match) keeps this weaker evidence category to a higher bar.
// decomposeBOQItem's (server.ts) own default values when no specific keyword matches - not a
// real classification, so must never be treated as a matching criterion (see Tier 2/3 below).
const GENERIC_MATERIAL_FALLBACK = "Standard Material Group";
const GENERIC_ACTIVITY_FALLBACK = "General Construction";
// Synthetic match-score inputs into selectHistoricalEvidence's ranking - lower than a real
// HistoricalRetrievalEngine candidate score at each successive tier, reflecting that the evidence
// is progressively less directly comparable to the target item.
const TIER_SYNTHETIC_SCORE: Record<Exclude<MatchTier, "Market Estimation" | "None">, number> = {
  "Specification Match": 70,
  "Material Match": 60,
  "Functional Match": 50
};

// Audit 0002 fix 1: relaxed-tier pools are now (a) bounded to the Stage-1 project
// shortlist - the same two-stage boundary every other evidence path already enforces,
// instead of quietly pooling rates from every project in the catalog - and (b) ranked by
// the synthetic tier score SCALED by the originating project's Stage-1 similarity,
// mirroring how a real HistoricalRetrievalEngine candidate's overallMatchScore already
// multiplies in its project factor. Before this, every tier candidate carried an
// identical flat score, so "selection" among them degenerated to array order - which is
// exactly how a corrupted ₹0.15 rate beat three legitimate ₹2,646-₹4,000 observations.
function buildCandidatesFromMasters(
  masters: MasterBOQItem[],
  syntheticScore: number,
  similarityByProjectName: Map<string, number>
): { rate: number; overallMatchScore: number; projectName: string }[] {
  const candidates: { rate: number; overallMatchScore: number; projectName: string }[] = [];
  for (const m of masters) {
    const rates = m.historicalRates || [];
    const projects = m.projects || [];
    for (let i = 0; i < rates.length; i++) {
      const rate = rates[i];
      if (!Number.isFinite(rate) || rate <= 0) continue;
      const projectName = projects[i];
      if (!projectName || !similarityByProjectName.has(projectName)) continue; // outside Stage-1 shortlist
      const projectSimilarity = similarityByProjectName.get(projectName) as number;
      candidates.push({
        rate,
        overallMatchScore: Math.round(syntheticScore * projectSimilarity),
        projectName
      });
    }
  }
  return candidates;
}

export const ProgressiveMatchingEngine = {
  estimateForUnmatchedItem(params: {
    item: RFQItem;
    allMasterItems: MasterBOQItem[];
    similarityByProjectName: Map<string, number>;
    buildingGrade: string;
    projectByName: Map<string, HistoricalBOQ>;
    currentYear: number;
    learningAnalysis: LearningAnalysis;
    domainAverageRate: number;
  }): ProgressiveMatchResult {
    const { item, allMasterItems, similarityByProjectName, buildingGrade, projectByName, currentYear, learningAnalysis, domainAverageRate } = params;
    const decomp = item.itemDecomposition;
    const domainPool = allMasterItems.filter((m) => m.domain === item.domain && m.historicalRates && m.historicalRates.length > 0);

    const tryTier = (masters: MasterBOQItem[], tier: Exclude<MatchTier, "Market Estimation" | "None">): ProgressiveMatchResult | null => {
      if (masters.length === 0) return null;
      const candidates = buildCandidatesFromMasters(masters, TIER_SYNTHETIC_SCORE[tier], similarityByProjectName);
      const stats = ProjectCalibrationEngine.selectHistoricalEvidence(
        undefined,
        similarityByProjectName,
        candidates,
        buildingGrade,
        projectByName,
        currentYear,
        item.domain,
        learningAnalysis
      );
      if (!stats || stats.referenceCount < MIN_RELAXED_TIER_REFERENCES) return null;
      return {
        applied: true,
        finalRate: stats.representativeRate,
        tier,
        referenceCount: stats.referenceCount,
        marketStats: stats,
        explanation: `No direct historical match for "${item.originalDescription}" - estimated via ${tier} using the closest of ${stats.referenceCount} reference(s) from other ${item.domain} items sharing the same ${tier === "Specification Match" ? "specification" : tier === "Material Match" ? "material" : "functional activity"}. Selected rate: Rs.${stats.selectedRate.toFixed(2)}.`
      };
    };

    // Tier 1: Specification Match - candidates whose classified specification text substantially
    // overlaps, even though they didn't clear HistoricalRetrievalEngine's stricter (45%) semantic
    // gate on the raw description.
    if (decomp?.specification) {
      const specMasters = domainPool.filter(
        (m) => HistoricalRetrievalEngine.wordOverlapScore(decomp.specification, m.precomputedSpecification || m.standardDescription) >= 40
      );
      const result = tryTier(specMasters, "Specification Match");
      if (result) return result;
    }

    // Tier 2: Material Match - exact match on the classified material bucket. decomposeBOQItem
    // maps descriptions onto a small fixed vocabulary (e.g. "Vitrified Tiles", "BWR Plywood"), so
    // exact equality here is a meaningful signal, not a coincidental string match - EXCEPT for its
    // own generic fallback value ("Standard Material Group"), which just means "didn't match any
    // known material keyword", not "same material as every other unclassified item in the
    // domain". Matching on that shared absence of classification (92% of Mechanical master items
    // fall into it) produced nonsense - e.g. a 0.63 TR AC cassette priced at Rs.500 by averaging
    // against 267 completely unrelated "unclassified" Mechanical items.
    if (decomp?.material && decomp.material !== GENERIC_MATERIAL_FALLBACK) {
      const materialMasters = domainPool.filter((m) => m.precomputedMaterial === decomp.material);
      const result = tryTier(materialMasters, "Material Match");
      if (result) return result;
    }

    // Tier 3: Functional Match - same classified activity within the domain (e.g. "Masonry",
    // "Flooring & Tiling"), regardless of material or specification. decomposeBOQItem only has one
    // classification level above material, so this is the broadest genuinely-informative tier
    // before falling to a flat domain average. Same generic-fallback guard as Tier 2 applies here
    // ("General Construction" is decomposeBOQItem's default activity, not a real classification).
    if (decomp?.activity && decomp.activity !== GENERIC_ACTIVITY_FALLBACK) {
      const activityMasters = domainPool.filter((m) => m.precomputedActivity === decomp.activity);
      const result = tryTier(activityMasters, "Functional Match");
      if (result) return result;
    }

    // No "Market Estimation" domain-average fallback here (removed) - a flat domain-wide average
    // is exactly the "Average Historical Rate" concept the engine must never produce. If no
    // item-family evidence survives even relaxed matching, there is genuinely nothing to reason
    // from - this falls through to Manual Pricing rather than guessing an average.
    return { applied: false, finalRate: 0, tier: "None", referenceCount: 0, marketStats: null, explanation: `No commercially-equivalent historical evidence found for "${item.originalDescription}" even under relaxed matching - manual pricing required.` };
  }
};
