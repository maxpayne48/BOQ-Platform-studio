import { MasterBOQItem, RFQItem } from "./types.js";
import { EngineeringAdjustmentEngine } from "./EngineeringAdjustmentEngine.js";

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
}

// domain -> coarse family token -> master items sharing that token. Built once per run.
export type DomainFamilyIndex = Map<string, Map<string, MasterBOQItem[]>>;

const SCORE_WEIGHTS = {
  semantic: 0.25,
  specification: 0.2,
  material: 0.15,
  project: 0.2,
  dimension: 0.1,
  engineering: 0.1
};

const FAMILY_TOKEN_OVERLAP_THRESHOLD = 0.4; // looser than EngineeringAdjustmentEngine's 0.6 -
// this stage is a coarse RETRIEVAL filter (cheap to compute, casts a slightly wider net); the
// finer-grained semantic score below does the actual discriminating.
const FALLBACK_PROJECT_WEIGHT = 0.35; // same convention as ProjectCalibrationEngine - a
// historical reference from a project outside the current Top 5 is still considered, just with
// a modest default project-similarity score instead of 0.

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

function wordOverlapScore(a: string, b: string): number {
  const wa = wordSet(a);
  const wb = wordSet(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  wa.forEach((w) => {
    if (wb.has(w)) common++;
  });
  return (common / Math.max(wa.size, wb.size)) * 100;
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
  }): HistoricalCandidate[] {
    const { item, domainFamilyIndex, similarityByProjectName, projectType, buildingGrade, checkUomCompatible } = params;
    const maxCandidates = params.maxCandidates ?? 10;

    const itemDescriptor = EngineeringAdjustmentEngine.extractDescriptor(item.originalDescription);
    const itemToken = familyToken(itemDescriptor.familyKey || item.originalDescription);
    const itemGrade = deriveProjectGrade("", buildingGrade);

    // --- Retrieval: only look inside this item's own domain bucket, and only the family-token
    // buckets that plausibly relate to it (its own token, plus any token in the domain whose
    // family key overlaps enough) - never the full catalog. ---
    const domainBucket = domainFamilyIndex.get(item.domain || "Uncategorized");
    if (!domainBucket) return [];

    const candidateMasters: MasterBOQItem[] = [];
    for (const [token, masters] of domainBucket.entries()) {
      if (token === itemToken || wordOverlapScore(itemToken, token) >= FAMILY_TOKEN_OVERLAP_THRESHOLD * 100) {
        candidateMasters.push(...masters);
      }
    }
    if (candidateMasters.length === 0) return [];

    const candidates: HistoricalCandidate[] = [];

    for (const master of candidateMasters) {
      const masterDescriptor = EngineeringAdjustmentEngine.extractDescriptor(master.standardDescription);

      // --- Filtering (hard gates: a mismatch here makes the candidate structurally unsound as
      // market evidence, not just "less similar") ---
      const semanticOverlap = wordOverlapScore(item.originalDescription, master.standardDescription);
      if (semanticOverlap < 20) continue; // Item Family gate

      const uomOk = checkUomCompatible(item.unit, master.standardUnit || item.unit);
      if (!uomOk) continue; // UOM gate

      // --- Similarity Scoring: one candidate row per historical occurrence backing this master
      // item (each occurrence carries its own originating project, per Rule 6's "consider all
      // relevant projects" convention rather than collapsing to the master's single average). ---
      const rates = master.historicalRates || [];
      const projects = master.projects || [];

      for (let i = 0; i < rates.length; i++) {
        const rate = rates[i];
        if (!Number.isFinite(rate) || rate <= 0) continue;
        const projectName = projects[i] || "Unknown Project";

        const specificationSimilarity = wordOverlapScore(
          item.itemDecomposition?.specification || item.originalDescription,
          master.itemDecomposition?.specification || master.standardDescription
        );
        const materialSimilarity = item.itemDecomposition?.material && master.itemDecomposition?.material
          ? wordOverlapScore(item.itemDecomposition.material, master.itemDecomposition.material)
          : semanticOverlap; // fall back to overall description overlap when material isn't decomposed

        const projectSimilarityRaw = similarityByProjectName.has(projectName)
          ? (similarityByProjectName.get(projectName) as number)
          : FALLBACK_PROJECT_WEIGHT;
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

        const overallMatchScore = Math.round(
          scores.semantic * SCORE_WEIGHTS.semantic +
          scores.specification * SCORE_WEIGHTS.specification +
          scores.material * SCORE_WEIGHTS.material +
          scores.project * SCORE_WEIGHTS.project +
          scores.dimension * SCORE_WEIGHTS.dimension +
          scores.engineering * SCORE_WEIGHTS.engineering
        );

        candidates.push({
          masterId: master.id,
          standardDescription: master.standardDescription,
          domain: master.domain,
          projectName,
          rate,
          overallMatchScore,
          scores
        });
      }
    }

    // --- Ranking + Top Candidate Selection: sort and cap, but return the LIST, never a single
    // pick - the pricing engine decides how to use it. ---
    return candidates
      .sort((a, b) => b.overallMatchScore - a.overallMatchScore)
      .slice(0, maxCandidates);
  }
};
