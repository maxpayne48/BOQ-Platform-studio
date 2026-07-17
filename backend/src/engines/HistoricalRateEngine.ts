/**
 * HistoricalRateEngine (implemented)
 *
 * Retrieves and ranks historical rate evidence for a parsed EngineeringItem, searching
 * only within the Top 5 Similar Projects supplied by ProjectSimilarityEngine. It never
 * calculates a final recommendation, average, median, adjusted rate, UOM conversion, or
 * confidence - its only job is to find and rank historical evidence. RecommendationEngineV2
 * decides what to do with the result.
 *
 * Data source: KnowledgeBaseEngine's Master BOQ catalog (read-only, via IKnowledgeBaseEngine
 * - the single source of truth). No dependency on EngineeringParser, ProjectSimilarityEngine,
 * BasicRateEngine, UOMEngine, or ConfidenceEngine beyond their exported *types* (used only
 * to describe this engine's own input/output shapes).
 */

import type { IKnowledgeBaseEngine, MasterCatalogItem } from "./KnowledgeBaseEngine.js";
import type { EngineeringItem } from "./EngineeringParser.js";
import type { ProjectSimilarityResult } from "./ProjectSimilarityEngine.js";

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

export type HistoricalMatchType = "EXACT_MATCH" | "SPECIFICATION_MATCH" | "MATERIAL_MATCH" | "PARTIAL_MATCH" | "NO_MATCH";

export interface HistoricalRateQuery {
  engineeringItem: EngineeringItem;
  /** Output of ProjectSimilarityEngine.findTopSimilarProjects(...).results - up to 5 projects. */
  topSimilarProjects: ProjectSimilarityResult[];
}

export interface HistoricalRateCandidate {
  historicalProjectId: string;
  historicalProjectName: string;
  worksheetName?: string;
  excelRowNumber?: number;
  historicalItemDescription: string;
  historicalRate: number;
  historicalQuantity?: number;
  historicalUOM: string;
  matchType: HistoricalMatchType;
  /** 0-100. Engineering Match (70%) + Project Similarity (30%). Retrieval relevance only -
   *  this is NOT recommendation confidence, which is ConfidenceEngine's responsibility. */
  matchScore: number;
}

export interface HistoricalRateResult {
  engineeringItem: EngineeringItem;
  matchType: HistoricalMatchType;
  candidates: HistoricalRateCandidate[];
  bestHistoricalRate?: number;
  sourceProject?: string;
  worksheet?: string;
  rowNumber?: number;
}

export interface HistoricalRateEngineOptions {
  /** How long the project->masterItem index is trusted before being rebuilt. */
  cacheTtlMs?: number;
  /** Relative tolerance for numeric comparisons (thickness/dimensions). Default 10%. */
  numericTolerance?: number;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface IHistoricalRateEngine {
  findHistoricalRates(query: HistoricalRateQuery): Promise<HistoricalRateResult>;
  /** Forces the project->masterItem index to be rebuilt from KnowledgeBaseEngine on the next query. */
  invalidateCache(): void;
}

// ---------------------------------------------------------------------------
// Scoring weights (sum to 100; order mirrors the required match priority)
// ---------------------------------------------------------------------------

const ATTRIBUTE_WEIGHTS = {
  masterItemId: 30,
  material: 20,
  specification: 15,
  grade: 10,
  thickness: 8,
  dimensions: 7,
  brand: 5,
  executionMethod: 3,
  uom: 2
} as const;

const ENGINEERING_MATCH_WEIGHT = 0.7;
const PROJECT_SIMILARITY_WEIGHT = 0.3;

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_NUMERIC_TOLERANCE = 0.1;
const MAX_CANDIDATES = 10;

interface EngineeringMatchOutcome {
  matchType: HistoricalMatchType;
  score: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class HistoricalRateEngine implements IHistoricalRateEngine {
  private readonly cacheTtlMs: number;
  private readonly numericTolerance: number;

  // Indexed lookup: projectId -> the set of master item ids that have at least one
  // historical occurrence from that project. Built once from KnowledgeBaseEngine and
  // reused across calls until stale - a query only ever touches the 5 buckets named by
  // its Top 5 Similar Projects, never the full catalog.
  private projectIndex: Map<string, Set<string>> = new Map();
  private itemById: Map<string, MasterCatalogItem> = new Map();
  private lastIndexBuildAt = 0;

  constructor(
    private readonly knowledgeBase: IKnowledgeBaseEngine,
    options: HistoricalRateEngineOptions = {}
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.numericTolerance = options.numericTolerance ?? DEFAULT_NUMERIC_TOLERANCE;
  }

  invalidateCache(): void {
    this.projectIndex = new Map();
    this.itemById = new Map();
    this.lastIndexBuildAt = 0;
  }

  // --- Indexed lookup (never scan all projects repeatedly) ------------------

  private async ensureIndex(): Promise<void> {
    const isFresh = this.lastIndexBuildAt > 0 && Date.now() - this.lastIndexBuildAt < this.cacheTtlMs;
    if (isFresh) return;

    const allItems = await this.knowledgeBase.list();
    const projectIndex = new Map<string, Set<string>>();
    const itemById = new Map<string, MasterCatalogItem>();

    for (const item of allItems) {
      itemById.set(item.id, item);
      for (const occurrence of item.historicalOccurrences) {
        const bucket = projectIndex.get(occurrence.projectId) ?? new Set<string>();
        bucket.add(item.id);
        projectIndex.set(occurrence.projectId, bucket);
      }
    }

    this.projectIndex = projectIndex;
    this.itemById = itemById;
    this.lastIndexBuildAt = Date.now();
  }

  /** Union of master item ids that have historical evidence in any of the given projects. */
  private getCandidateMasterItemIds(projectIds: string[]): Set<string> {
    const ids = new Set<string>();
    for (const projectId of projectIds) {
      const bucket = this.projectIndex.get(projectId);
      if (bucket) bucket.forEach((id) => ids.add(id));
    }
    return ids;
  }

  // --- Comparison helpers ---------------------------------------------------

  private textEquals(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  private numericClose(a: number | undefined, b: number | undefined): boolean {
    if (a === undefined || b === undefined) return false;
    if (a === b) return true;
    const base = Math.max(Math.abs(a), Math.abs(b));
    if (base === 0) return false;
    return Math.abs(a - b) / base <= this.numericTolerance;
  }

  // --- Engineering attribute matching (priority order) -----------------------

  /**
   * Scores a candidate Master Item against the parsed EngineeringItem using the required
   * priority order. "Master Item ID" has no direct counterpart on EngineeringItem (it
   * carries no catalog id of its own), so an exact canonical-description match against an
   * already project-narrowed candidate is treated as identifying the same master item -
   * the strongest possible signal available without a full-catalog identity lookup.
   */
  private scoreEngineeringMatch(item: EngineeringItem, candidate: MasterCatalogItem): EngineeringMatchOutcome {
    let score = 0;

    const matchedMasterItemId = this.textEquals(item.general.canonicalDescription, candidate.canonicalDescription);
    if (matchedMasterItemId) score += ATTRIBUTE_WEIGHTS.masterItemId;

    const matchedMaterial = this.textEquals(item.material.material, candidate.material);
    if (matchedMaterial) score += ATTRIBUTE_WEIGHTS.material;

    const specSignature = [item.material.grade, item.specifications.strengthClass, item.material.finish]
      .filter(Boolean)
      .join(" ")
      .trim()
      .toLowerCase();
    const matchedSpecification = Boolean(
      specSignature && candidate.specification && candidate.specification.toLowerCase().includes(specSignature)
    );
    if (matchedSpecification) score += ATTRIBUTE_WEIGHTS.specification;

    const matchedGrade = this.textEquals(item.material.grade, candidate.grade);
    if (matchedGrade) score += ATTRIBUTE_WEIGHTS.grade;

    const matchedThickness = this.numericClose(item.specifications.thickness, candidate.thickness);
    if (matchedThickness) score += ATTRIBUTE_WEIGHTS.thickness;

    const matchedDimensions =
      this.numericClose(item.specifications.width, candidate.dimensions.width) &&
      this.numericClose(item.specifications.height, candidate.dimensions.height);
    if (matchedDimensions) score += ATTRIBUTE_WEIGHTS.dimensions;

    const matchedBrand = this.textEquals(item.material.brand, candidate.brand);
    if (matchedBrand) score += ATTRIBUTE_WEIGHTS.brand;

    const engineeringExecutionTerms = [item.execution.installationMethod, item.execution.constructionMethod]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLowerCase());
    const candidateExecution = candidate.executionMethod?.toLowerCase();
    const matchedExecutionMethod = Boolean(
      candidateExecution && engineeringExecutionTerms.some((term) => candidateExecution.includes(term) || term.includes(candidateExecution))
    );
    if (matchedExecutionMethod) score += ATTRIBUTE_WEIGHTS.executionMethod;

    const matchedUOM = this.textEquals(item.commercial.uom, candidate.uom);
    if (matchedUOM) score += ATTRIBUTE_WEIGHTS.uom;

    let matchType: HistoricalMatchType;
    if (matchedMasterItemId) {
      matchType = "EXACT_MATCH";
    } else if (matchedMaterial && (matchedSpecification || matchedGrade || matchedThickness || matchedDimensions)) {
      matchType = "SPECIFICATION_MATCH";
    } else if (matchedMaterial) {
      matchType = "MATERIAL_MATCH";
    } else if (matchedBrand || matchedExecutionMethod || matchedUOM) {
      matchType = "PARTIAL_MATCH";
    } else {
      matchType = "NO_MATCH";
    }

    return { matchType, score };
  }

  // --- Public query -------------------------------------------------------

  async findHistoricalRates(query: HistoricalRateQuery): Promise<HistoricalRateResult> {
    await this.ensureIndex();

    const projectSimilarityById = new Map(query.topSimilarProjects.map((p) => [p.projectId, p]));
    const candidateMasterItemIds = this.getCandidateMasterItemIds(query.topSimilarProjects.map((p) => p.projectId));

    const candidates: HistoricalRateCandidate[] = [];

    for (const masterItemId of candidateMasterItemIds) {
      const item = this.itemById.get(masterItemId);
      if (!item) continue;

      const engineeringMatch = this.scoreEngineeringMatch(query.engineeringItem, item);
      if (engineeringMatch.matchType === "NO_MATCH") continue;

      for (const occurrence of item.historicalOccurrences) {
        const project = projectSimilarityById.get(occurrence.projectId);
        if (!project) continue; // only evidence from the given Top 5 projects

        const matchScore = Math.round(
          engineeringMatch.score * ENGINEERING_MATCH_WEIGHT + project.similarityScore * PROJECT_SIMILARITY_WEIGHT
        );

        candidates.push({
          historicalProjectId: project.projectId,
          historicalProjectName: project.projectName,
          worksheetName: occurrence.worksheetName,
          excelRowNumber: occurrence.rowNumber,
          historicalItemDescription: occurrence.originalDescription,
          historicalRate: occurrence.rate,
          historicalQuantity: occurrence.quantity,
          historicalUOM: occurrence.unit,
          matchType: engineeringMatch.matchType,
          matchScore
        });
      }
    }

    candidates.sort((a, b) => b.matchScore - a.matchScore);
    const topCandidates = candidates.slice(0, MAX_CANDIDATES);

    if (topCandidates.length === 0) {
      return {
        engineeringItem: query.engineeringItem,
        matchType: "NO_MATCH",
        candidates: []
      };
    }

    const best = topCandidates[0];
    return {
      engineeringItem: query.engineeringItem,
      matchType: best.matchType,
      candidates: topCandidates,
      bestHistoricalRate: best.historicalRate,
      sourceProject: best.historicalProjectName,
      worksheet: best.worksheetName,
      rowNumber: best.excelRowNumber
    };
  }
}
