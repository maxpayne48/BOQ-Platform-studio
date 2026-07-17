/**
 * BasicRateEngine (implemented)
 *
 * Retrieves the appropriate Basic Rate (a bare material/component price, as recorded from
 * a "basic rate schedule"-style sheet during Historical BOQ ingestion) for a parsed
 * EngineeringItem. It never calculates a recommendation, never performs historical
 * project matching, and never scores project similarity - those are HistoricalRateEngine's
 * and ProjectSimilarityEngine's jobs respectively. RecommendationEngineV2 decides what to
 * do with whatever this engine returns.
 *
 * Data source: KnowledgeBaseEngine's Master BOQ catalog (read-only, via IKnowledgeBaseEngine
 * - the single source of truth), specifically each Master Item's basicRateOccurrences[],
 * which is exactly the "Basic Rate database generated during Historical BOQ ingestion."
 * No dependency on EngineeringParser, ProjectSimilarityEngine, HistoricalRateEngine,
 * UOMEngine, or ConfidenceEngine beyond their exported *types*.
 *
 * Lookup uses only KnowledgeBaseEngine's own pre-built attribute indexes
 * (getById / findByMaterial) - never a free-text description search, never a full-catalog
 * scan, and this file maintains no index of its own.
 */

import type { IKnowledgeBaseEngine, MasterCatalogItem, HistoricalItemOccurrence } from "./KnowledgeBaseEngine.js";
import type { EngineeringItem } from "./EngineeringParser.js";

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

export interface BasicRateQuery {
  engineeringItem: EngineeringItem;
  /**
   * Optional. If some earlier stage has already resolved this item to a specific Master
   * Item ID, pass it for a direct, tier-1 lookup. Not required - EngineeringItem carries
   * no catalog id of its own, so most callers will omit this and fall through to the
   * Material-anchored tiers below.
   */
  masterItemId?: string;
}

export interface BasicRateResult {
  found: boolean;
  basicRate?: number;
  rateType?: string;
  sourceProject?: string;
  worksheet?: string;
  rowNumber?: number;
  version?: string;
  effectiveDate?: string;
  matchScore?: number;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface IBasicRateEngine {
  findBasicRate(query: BasicRateQuery): Promise<BasicRateResult>;
}

// ---------------------------------------------------------------------------
// Scoring weights (sum to 100; order mirrors the required lookup priority once the
// Material gate is passed - Master Item ID is a separate, full-score direct hit)
// ---------------------------------------------------------------------------

const MASTER_ITEM_ID_SCORE = 100;

const REFINEMENT_WEIGHTS = {
  material: 40,
  specification: 25,
  grade: 15,
  thickness: 10,
  dimensions: 7,
  uom: 3
} as const;

/** Every basicRateOccurrence represents a bare material/component price by construction
 *  (that is what distinguishes a "basic rate schedule" sheet from a full BOQ sheet during
 *  Historical BOQ ingestion) - so this is a constant label, not a computed classification. */
const RATE_TYPE_LABEL = "Material";

const NUMERIC_TOLERANCE = 0.1;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class BasicRateEngine implements IBasicRateEngine {
  constructor(private readonly knowledgeBase: IKnowledgeBaseEngine) {}

  async findBasicRate(query: BasicRateQuery): Promise<BasicRateResult> {
    // Priority 1: Master Item ID - a direct, indexed identity lookup.
    if (query.masterItemId) {
      const item = await this.knowledgeBase.getById(query.masterItemId);
      if (item && item.basicRateOccurrences.length > 0) {
        return this.buildResult(item.basicRateOccurrences, MASTER_ITEM_ID_SCORE);
      }
    }

    // Priority 2 (the first achievable tier without a resolved id): Material, via
    // KnowledgeBaseEngine's own material index - never a free-text description search.
    const material = query.engineeringItem.material.material;
    if (!material) {
      return { found: false };
    }

    const materialCandidates = await this.knowledgeBase.findByMaterial(material);
    const candidatesWithBasicRate = materialCandidates.filter((item) => item.basicRateOccurrences.length > 0);
    if (candidatesWithBasicRate.length === 0) {
      return { found: false };
    }

    // Priorities 3-7 (Specification, Grade, Thickness, Dimensions, UOM) refine the
    // material-anchored candidate pool in memory - no further KnowledgeBaseEngine calls
    // are needed since findByMaterial already returned each candidate's full attributes.
    let best: { item: MasterCatalogItem; score: number } | undefined;
    for (const candidate of candidatesWithBasicRate) {
      const score = this.scoreCandidate(query.engineeringItem, candidate);
      if (!best || score > best.score) best = { item: candidate, score };
    }

    if (!best) return { found: false };

    return this.buildResult(best.item.basicRateOccurrences, best.score);
  }

  // --- Refinement scoring ---------------------------------------------------

  private scoreCandidate(engineeringItem: EngineeringItem, candidate: MasterCatalogItem): number {
    // Material match is guaranteed here (it is the gate that admitted this candidate).
    let score = REFINEMENT_WEIGHTS.material;

    const specSignature = [engineeringItem.material.grade, engineeringItem.specifications.strengthClass, engineeringItem.material.finish]
      .filter(Boolean)
      .join(" ")
      .trim()
      .toLowerCase();
    if (specSignature && candidate.specification && candidate.specification.toLowerCase().includes(specSignature)) {
      score += REFINEMENT_WEIGHTS.specification;
    }

    if (this.textEquals(engineeringItem.material.grade, candidate.grade)) {
      score += REFINEMENT_WEIGHTS.grade;
    }

    if (this.numericClose(engineeringItem.specifications.thickness, candidate.thickness)) {
      score += REFINEMENT_WEIGHTS.thickness;
    }

    if (
      this.numericClose(engineeringItem.specifications.width, candidate.dimensions.width) &&
      this.numericClose(engineeringItem.specifications.height, candidate.dimensions.height)
    ) {
      score += REFINEMENT_WEIGHTS.dimensions;
    }

    if (this.textEquals(engineeringItem.commercial.uom, candidate.uom)) {
      score += REFINEMENT_WEIGHTS.uom;
    }

    return score;
  }

  private textEquals(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  private numericClose(a: number | undefined, b: number | undefined): boolean {
    if (a === undefined || b === undefined) return false;
    if (a === b) return true;
    const base = Math.max(Math.abs(a), Math.abs(b));
    if (base === 0) return false;
    return Math.abs(a - b) / base <= NUMERIC_TOLERANCE;
  }

  // --- Result assembly -------------------------------------------------------

  /**
   * Returns the single most recently recorded basic rate occurrence, never an average,
   * median, or interpolated value. "Version" is derived from this occurrence's
   * chronological position among all of the item's basic rate occurrences (1-based) since
   * the underlying ingestion data carries no explicit version number of its own.
   */
  private buildResult(occurrences: HistoricalItemOccurrence[], matchScore: number): BasicRateResult {
    const chronological = [...occurrences].sort(
      (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()
    );
    const mostRecent = chronological[chronological.length - 1];
    const version = chronological.length;

    return {
      found: true,
      basicRate: mostRecent.rate,
      rateType: RATE_TYPE_LABEL,
      sourceProject: mostRecent.projectName,
      worksheet: mostRecent.worksheetName,
      rowNumber: mostRecent.rowNumber,
      version: `v${version}`,
      effectiveDate: mostRecent.recordedAt,
      matchScore
    };
  }
}
