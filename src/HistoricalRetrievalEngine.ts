import { MasterBOQItem, RFQItem } from "./types.js";
import { EngineeringAdjustmentEngine, isCommerciallyEquivalent } from "./EngineeringAdjustmentEngine.js";

// Historical Retrieval redesign - runs strictly AFTER the existing (frozen) item matching,
// specification matching, and UOM logic. Never re-derives item.matchedMasterId, never changes
// which item RecommendationEngineV2 considers "the" match, and never itself picks a winning
// rate - it only replaces the old "grab the single historical rate from the Top 5 similar
// projects" step with a proper multi-stage retrieval pipeline:
//
//   Item Match (existing, untouched) -> Historical Candidate Retrieval -> Filtering ->
//   Similarity Scoring -> Ranking -> [ranked list handed to the pricing engine, never
//   auto-selected here]
//
// Performance: candidates are retrieved from a small pre-built index (grouped by Domain, then by
// a coarse item-family token), built ONCE per recommendation run over the whole master catalog,
// not re-scanned per item. Each item's retrieval only ever compares against its own bucket, never
// the full catalog, so cost scales with catalog size once (index build) plus a small bucket per
// item rather than O(items x catalogSize).

export interface HistoricalCandidate {
  masterId: string;
  standardDescription: string;
  domain: string;
  projectName: string;
  rate: number;
  overallMatchScore: number;
  scores: {
    semantic: number;
    specification: number;
    material: number;
    project: number;
    dimension: number;
    engineering: number;
  };
  // Step 4 (Historical Evidence): the worksheet this occurrence came from, used as the "Section"
  // field in the evidence pool - purely informational/explainability, never affects scoring.
  section?: string;
}

// Step 7 (Explainability): "which historical items were discarded, why" - every hard gate below
// records what it rejected instead of silently skipping it.
export interface RejectedHistoricalCandidate {
  standardDescription: string;
  projectName: string;
  reason: string;
}

// domain -> coarse family token -> master items sharing that token. Built once per run.
export type DomainFamilyIndex = Map<string, Map<string, MasterBOQItem[]>>;

// Step 5 (Weighted Evidence): overallMatchScore is a PRODUCT of four normalized (0-1) factors, not
// an additive weighted sum. An additive sum lets weak factors get diluted by strong ones (e.g. a
// project with poor project-similarity but decent text overlap could still score close to a
// project that's strong on everything) - this is what produced the near-equal "33/33/33"
// contribution splits regardless of real similarity differences. Multiplication punishes a single
// weak factor sharply, so strong evidence naturally dominates the weighted-median distribution
// downstream (ProjectCalibrationEngine) without needing any special-cased "is this an exact
// historical match" rule anywhere. The four factors reuse the same six underlying scores computed
// below, regrouped (no new scoring logic invented):
//   Project Similarity      = scores.project (Stage 1 project-ranking score, unchanged)
//   Item Similarity         = semantic*0.625 + material*0.375 (same 5:3 ratio the old additive
//                              weights .25/.15 already had, renormalized to sum to 1)
//   Specification Similarity = scores.specification (independent factor, not folded into a sum)
//   Confidence               = dimension*0.5 + engineering*0.5 (same equal .1/.1 ratio as before),
//                              rescaled so that "not applicable" (score 50, the neutral default
//                              both use when no dimension/engineering kind applies to either side)
//                              maps to full confidence (1.0) rather than a flat 50% penalty - under
//                              multiplication a 50% "neutral" factor would otherwise halve the
//                              whole product for the majority of ordinary, non-dimensional BOQ
//                              items that this factor was never meant to penalize. A genuine
//                              mismatch (score well below 50) still reduces confidence properly.
const ITEM_SIMILARITY_SEMANTIC_SHARE = 0.625;
const ITEM_SIMILARITY_MATERIAL_SHARE = 0.375;

const FAMILY_TOKEN_OVERLAP_THRESHOLD = 0.4; // looser than EngineeringAdjustmentEngine's 0.6 -
// this stage is a coarse RETRIEVAL filter (cheap to compute, casts a slightly wider net); the
// finer-grained semantic score below does the actual discriminating.

function familyToken(familyKey: string): string {
  const firstWord = familyKey.split(" ").find((w) => w.length > 2);
  return firstWord || familyKey || "misc";
}

function wordSet(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

// Numeric-spec guard (mirrors the same fix in server.ts's calculateWordOverlap, used for master-
// item clustering at ingestion time): the word filter above drops numeric tokens of length <= 2
// (e.g. "10", "16", "70") while keeping longer ones (e.g. "300"), so a "10 Sqmm" cable and an
// unrelated "300 Sqmm" cable could score a high word overlap on "core"/"sqmm" alone and pass the
// semantic gate below as if they were the same spec. Extract numeric tokens with no length
// restriction and require most of them to agree (Jaccard overlap) whenever either side has any -
// requiring just one shared number isn't enough either, since e.g. "3.5 Core X 300 Sqmm" and
// "3.5 Core X 150 Sqmm" share the core-count number while differing on the actual cross-section.
function numberSet(text: string): Set<string> {
  return new Set((text || "").match(/\d+(?:\.\d+)?/g) || []);
}

function numericJaccard(a: string, b: string): number {
  const na = numberSet(a);
  const nb = numberSet(b);
  if (na.size === 0 && nb.size === 0) return 1;
  let intersection = 0;
  na.forEach((n) => {
    if (nb.has(n)) intersection++;
  });
  const union = new Set([...na, ...nb]).size;
  return union > 0 ? intersection / union : 1;
}

function wordOverlapScore(a: string, b: string): number {
  const wa = wordSet(a);
  const wb = wordSet(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  wa.forEach((w) => {
    if (wb.has(w)) common++;
  });
  const baseScore = (common / Math.max(wa.size, wb.size)) * 100;
  if (numericJaccard(a, b) < 0.5) return Math.min(baseScore, 30);
  return baseScore;
}

function deriveProjectGrade(projectName: string, projectType: string): string {
  // Mirrors RecommendationEngineV2.getSimilarProjects' own grade heuristic exactly (read-only -
  // this file never imports or modifies that function, just applies the same simple keyword
  // convention so "Building Type" comparisons stay consistent with existing project similarity).
  const text = `${projectName} ${projectType || ""}`.toLowerCase();
  if (text.includes("grade a") || text.includes("premium") || text.includes("luxury")) return "Grade A";
  if (text.includes("grade b") || text.includes("standard")) return "Grade B";
  return "Grade A";
}

export const HistoricalRetrievalEngine = {
  // Step 0 (performance): build the Domain -> family-token index once per recommendation run.
  buildDomainFamilyIndex(allMasterItems: MasterBOQItem[]): DomainFamilyIndex {
    const index: DomainFamilyIndex = new Map();
    for (const m of allMasterItems) {
      if (!m.standardDescription || !m.historicalRates || m.historicalRates.length === 0) continue;
      const descriptor = EngineeringAdjustmentEngine.extractDescriptor(m.standardDescription);
      const token = familyToken(descriptor.familyKey || m.standardDescription);
      const domainKey = m.domain || "Uncategorized";
      if (!index.has(domainKey)) index.set(domainKey, new Map());
      const domainBucket = index.get(domainKey)!;
      if (!domainBucket.has(token)) domainBucket.set(token, []);
      domainBucket.get(token)!.push(m);
    }
    return index;
  },

  // Exposed for src/ProgressiveMatchingEngine.ts, which reuses this exact (numeric-guard-aware)
  // word-overlap scoring for its own relaxed-tier matching rather than re-implementing it.
  wordOverlapScore,

  // Steps 1-5: Historical Candidate Retrieval -> Filtering -> Similarity Scoring -> Ranking.
  // Returns the ranked list only - deliberately does NOT pick a winner (that decision belongs to
  // the pricing engine downstream, per the explicit "do not auto-select" requirement).
  retrieveRankedHistoricalCandidates(params: {
    item: RFQItem;
    domainFamilyIndex: DomainFamilyIndex;
    similarityByProjectName: Map<string, number>;
    projectType: string;
    buildingGrade: string;
    checkUomCompatible: (rfqUnit: string, masterUnit: string) => boolean;
    maxCandidates?: number;
  }): { candidates: HistoricalCandidate[]; rejectedCandidates: RejectedHistoricalCandidate[] } {
    const { item, domainFamilyIndex, similarityByProjectName, projectType, buildingGrade, checkUomCompatible } = params;
    const maxCandidates = params.maxCandidates ?? 10;
    const rejectedCandidates: RejectedHistoricalCandidate[] = [];

    const itemDescriptor = EngineeringAdjustmentEngine.extractDescriptor(item.originalDescription);
    const itemToken = familyToken(itemDescriptor.familyKey || item.originalDescription);
    const itemGrade = deriveProjectGrade("", buildingGrade);

    // --- Retrieval: only look inside this item's own domain bucket, and only the family-token
    // buckets that plausibly relate to it (its own token, plus any token in the domain whose
    // family key overlaps enough) - never the full catalog. ---
    const domainBucket = domainFamilyIndex.get(item.domain || "Uncategorized");
    if (!domainBucket) return { candidates: [], rejectedCandidates };

    const candidateMasters: MasterBOQItem[] = [];
    for (const [token, masters] of domainBucket.entries()) {
      if (token === itemToken || wordOverlapScore(itemToken, token) >= FAMILY_TOKEN_OVERLAP_THRESHOLD * 100) {
        candidateMasters.push(...masters);
      }
    }
    if (candidateMasters.length === 0) return { candidates: [], rejectedCandidates };

    const candidates: HistoricalCandidate[] = [];

    for (const master of candidateMasters) {
      const masterDescriptor = EngineeringAdjustmentEngine.extractDescriptor(master.standardDescription);

      // --- Filtering (hard gates: a mismatch here makes the candidate structurally unsound as
      // market evidence, not just "less similar") ---
      // Threshold raised from 20 -> 45: at 20, two genuinely different products that merely share
      // one or two generic words (e.g. "Decorative Hanging Light" vs. an unrelated fixture also
      // containing the word "light") were passing this gate and entering the same market-rate
      // distribution as the correct match, dragging representativeRate toward a completely
      // different price tier. 45 requires roughly half of an item's significant words to match,
      // which still admits spec/dimension variants of the same item (those routinely score
      // 60-90%) while excluding coincidental word overlap between unrelated items.
      const semanticOverlap = wordOverlapScore(item.originalDescription, master.standardDescription);
      if (semanticOverlap < 45) {
        rejectedCandidates.push({ standardDescription: master.standardDescription, projectName: master.projects?.[0] || "N/A", reason: "Item description too dissimilar (below Item Family match threshold)" });
        continue; // Item Family gate
      }

      const uomOk = checkUomCompatible(item.unit, master.standardUnit || item.unit);
      if (!uomOk) {
        rejectedCandidates.push({ standardDescription: master.standardDescription, projectName: master.projects?.[0] || "N/A", reason: `Unit of measure incompatible (RFQ: ${item.unit}, Historical: ${master.standardUnit || item.unit})` });
        continue; // UOM gate
      }

      // Step 3 (Commercial Equivalence) - text similarity alone can't tell "12mm Toughened Glass"
      // from "12mm Fire Rated Glass" apart; this catches that class of mismatch explicitly.
      const equivalence = isCommerciallyEquivalent(item.originalDescription, master.standardDescription);
      if (!equivalence.equivalent) {
        rejectedCandidates.push({ standardDescription: master.standardDescription, projectName: master.projects?.[0] || "N/A", reason: equivalence.reason || "Commercially non-equivalent product" });
        continue;
      }

      // --- Similarity Scoring: one candidate row per historical occurrence backing this master
      // item (each occurrence carries its own originating project, per Rule 6's "consider all
      // relevant projects" convention rather than collapsing to the master's single average). ---
      const rates = master.historicalRates || [];
      const projects = master.projects || [];
      const worksheets = master.historicalWorksheets || [];

      for (let i = 0; i < rates.length; i++) {
        const rate = rates[i];
        if (!Number.isFinite(rate) || rate <= 0) continue;
        const projectName = projects[i] || "Unknown Project";
        const section = worksheets[i];

        // Stage 2 boundary (Problem 2 fix): item matching happens ONLY within the Stage 1
        // shortlist of ranked historical projects (similarityByProjectName) - never the whole
        // historical database. An occurrence from a project outside the shortlist is not "counted
        // anyway at a discount" (the old FALLBACK_PROJECT_WEIGHT behavior) - it's excluded
        // entirely, so a dissimilar project's item can never outrank a genuinely relevant one.
        if (!similarityByProjectName.has(projectName)) continue;

        // Master items store their decomposition under precomputedX fields (set by
        // precomputeMasterItemFields in server.ts), not a nested itemDecomposition object - these
        // used to read item.itemDecomposition?.specification/master.itemDecomposition?.material,
        // which was never populated on either side, so both scores silently duplicated
        // semanticOverlap for every candidate instead of being independent signals.
        const specificationSimilarity = wordOverlapScore(
          item.itemDecomposition?.specification || item.originalDescription,
          master.precomputedSpecification || master.standardDescription
        );
        const materialSimilarity = item.itemDecomposition?.material && master.precomputedMaterial
          ? wordOverlapScore(item.itemDecomposition.material, master.precomputedMaterial)
          : semanticOverlap; // fall back to overall description overlap when material isn't decomposed

        // Guaranteed present - occurrences from projects outside the Stage 1 shortlist were
        // already excluded above.
        const projectSimilarityRaw = similarityByProjectName.get(projectName) as number;
        const masterGrade = deriveProjectGrade(projectName, projectType);
        const projectScore = (projectSimilarityRaw * 100 + (masterGrade === itemGrade ? 10 : 0));

        let dimensionScore = 50; // neutral when no dimension is applicable to either side
        if (itemDescriptor.primaryDimension !== null && masterDescriptor.primaryDimension !== null && itemDescriptor.kind === masterDescriptor.kind) {
          const a = itemDescriptor.primaryDimension;
          const b = masterDescriptor.primaryDimension;
          const ratioDiff = Math.abs(a - b) / Math.max(a, b, 1);
          dimensionScore = Math.max(0, 100 - ratioDiff * 100);
        }

        let engineeringScore = 50;
        if (itemDescriptor.kind !== "none" && masterDescriptor.kind !== "none") {
          engineeringScore = itemDescriptor.kind === masterDescriptor.kind ? 70 + Math.min(30, semanticOverlap * 0.3) : 30;
        }

        const scores = {
          semantic: Math.round(semanticOverlap),
          specification: Math.round(specificationSimilarity),
          material: Math.round(materialSimilarity),
          project: Math.round(Math.min(100, projectScore)),
          dimension: Math.round(dimensionScore),
          engineering: Math.round(engineeringScore)
        };

        const projectFrac = scores.project / 100;
        const itemFrac = (scores.semantic * ITEM_SIMILARITY_SEMANTIC_SHARE + scores.material * ITEM_SIMILARITY_MATERIAL_SHARE) / 100;
        const specFrac = scores.specification / 100;
        const dimEngBlend = scores.dimension * 0.5 + scores.engineering * 0.5;
        const confidenceFrac = Math.min(1, 0.5 + dimEngBlend / 100);
        const overallMatchScore = Math.round(100 * projectFrac * itemFrac * specFrac * confidenceFrac);

        candidates.push({
          masterId: master.id,
          standardDescription: master.standardDescription,
          domain: master.domain,
          projectName,
          rate,
          overallMatchScore,
          scores,
          section
        });
      }
    }

    // --- Ranking: sort by overallMatchScore (project x item x specification x confidence) - this
    // IS the "closest commercial match" ranking the pricing engine will select the top of. ---
    const ranked = candidates.sort((a, b) => b.overallMatchScore - a.overallMatchScore);

    // --- Price-plausibility guard (non-statistical): even after the semantic/UOM/equivalence
    // gates above, a handful of candidates could still slip through with wildly different pricing
    // than the item's own best-matching evidence (e.g. a different product tier that happens to
    // share enough words to pass the family gate). Compare every other candidate directly against
    // the TOP-RANKED candidate's own rate (not a computed median/mean) - a candidate priced beyond
    // 3x or under 1/3 of the best match is treated as an inconsistent data point and discarded, not
    // blended away. This is what previously let a single unrelated candidate (e.g. a premium
    // fixture priced 10-20x a standard one) distort the recommendation for an item that otherwise
    // had a genuinely correct best match.
    const topRate = ranked.length > 0 ? ranked[0].rate : null;
    let plausibleCandidates = ranked;
    if (topRate !== null && topRate > 0) {
      const lowerBound = topRate / 3;
      const upperBound = topRate * 3;
      plausibleCandidates = ranked.filter((c, idx) => {
        if (idx === 0) return true; // the anchor itself is always kept
        const consistent = c.rate >= lowerBound && c.rate <= upperBound;
        if (!consistent) {
          rejectedCandidates.push({ standardDescription: c.standardDescription, projectName: c.projectName, reason: `Rate (₹${c.rate.toFixed(2)}) inconsistent with the best-matching evidence (₹${topRate.toFixed(2)})` });
        }
        return consistent;
      });
    }

    // --- Top Candidate Selection: cap, but return the LIST, never a single pick - the pricing
    // engine decides which one to select. ---
    return { candidates: plausibleCandidates.slice(0, maxCandidates), rejectedCandidates };
  }
};
