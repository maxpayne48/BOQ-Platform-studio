/**
 * ProjectSimilarityEngine (implemented)
 *
 * Given a Project Profile (cost, size, type, city, building grade - collected from the
 * Project Profile modal before any BOQ item is matched), returns the Top 5 historical
 * projects that are the best references for that estimate.
 *
 * Data source: KnowledgeBaseEngine's project metadata (read-only, via IKnowledgeBaseEngine
 * - the single source of truth). This engine never reads or writes KnowledgeBaseEngine's
 * store, never touches Master BOQ items, never matches a BOQ line item, and never
 * calculates a rate - it only ranks whole projects.
 *
 * Scope boundary (deliberate): no recommendation logic, no BOQ-item matching, no Master
 * BOQ search, no rate calculation. Not wired into any route this pass - implementation
 * only, per instruction.
 */

import type { IKnowledgeBaseEngine, ProjectMetadataRecord } from "./KnowledgeBaseEngine.js";

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

/** The 5 inputs collected by the Project Profile modal before matching begins. */
export interface ProjectProfileInput {
  projectCost: number;
  projectSize: number;
  projectType: string;
  city: string;
  buildingGrade: string;
}

export interface ProjectSimilarityResult {
  projectId: string;
  projectName: string;
  projectCost?: number;
  projectSize?: number;
  projectType?: string;
  city?: string;
  buildingGrade?: string;
  similarityScore: number; // 0-100
}

export type FallbackRecommendation = "none" | "basic-rate";

export interface ProjectSimilarityQueryResult {
  results: ProjectSimilarityResult[];
  /** "basic-rate" tells RecommendationEngineV2 to skip the historical-match path entirely. */
  fallbackRecommendation: FallbackRecommendation;
}

export interface SimilarityWeights {
  projectType: number;
  projectCost: number;
  projectSize: number;
  city: number;
  buildingGrade: number;
}

export interface ProjectSimilarityEngineOptions {
  /** How long the project-type index is trusted before being rebuilt from KnowledgeBaseEngine. */
  cacheTtlMs?: number;
}

/**
 * Preserved only so backend/src/engines/RecommendationEngineV2.ts (frozen this pass) keeps
 * compiling against its existing `import type { ProjectProfile, HistoricalProjectSummary }`
 * - that file only ever holds these as type annotations, it never calls a method against
 * them, so redefining them here as aliases of the real, actively-used types above is safe.
 */
export type ProjectProfile = ProjectProfileInput;
export interface HistoricalProjectSummary {
  id: string;
  projectName: string;
  profile: ProjectProfile;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface IProjectSimilarityEngine {
  /** Ranks historical projects against the target profile; returns at most topN (default 5). */
  findTopSimilarProjects(profile: ProjectProfileInput, topN?: number): Promise<ProjectSimilarityQueryResult>;

  getWeights(): SimilarityWeights;
  setWeights(weights: SimilarityWeights): void;

  /** Forces the project-type index to be rebuilt from KnowledgeBaseEngine on the next query. */
  invalidateCache(): void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS: SimilarityWeights = {
  projectType: 0.35,
  projectCost: 0.25,
  projectSize: 0.2,
  city: 0.15,
  buildingGrade: 0.05
};

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_TOP_N = 5;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ProjectSimilarityEngine implements IProjectSimilarityEngine {
  private weights: SimilarityWeights;
  private readonly cacheTtlMs: number;

  // Indexed lookup: project type (lowercased) -> its projects. Built once from
  // KnowledgeBaseEngine and reused across calls until it goes stale - queries never
  // re-scan the full project list, they only ever touch the buckets whose type matches
  // or contains/is-contained-by the target type (plus the "unknown" bucket for projects
  // with no recorded type, which are never excluded just for missing that one field).
  private projectTypeIndex: Map<string, ProjectMetadataRecord[]> = new Map();
  private lastIndexBuildAt = 0;

  constructor(
    private readonly knowledgeBase: IKnowledgeBaseEngine,
    weights: SimilarityWeights = DEFAULT_WEIGHTS,
    options: ProjectSimilarityEngineOptions = {}
  ) {
    this.weights = weights;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  getWeights(): SimilarityWeights {
    return { ...this.weights };
  }

  setWeights(weights: SimilarityWeights): void {
    this.weights = weights;
  }

  invalidateCache(): void {
    this.projectTypeIndex = new Map();
    this.lastIndexBuildAt = 0;
  }

  // --- Indexed lookup (never scan all projects repeatedly) ------------------

  private async ensureIndex(): Promise<void> {
    const isFresh = this.lastIndexBuildAt > 0 && Date.now() - this.lastIndexBuildAt < this.cacheTtlMs;
    if (isFresh) return;

    const allProjects = await this.knowledgeBase.listProjectMetadata();
    const index = new Map<string, ProjectMetadataRecord[]>();

    for (const project of allProjects) {
      const key = (project.projectType ?? "unknown").trim().toLowerCase();
      const bucket = index.get(key) ?? [];
      bucket.push(project);
      index.set(key, bucket);
    }

    this.projectTypeIndex = index;
    this.lastIndexBuildAt = Date.now();
  }

  /** Ignores projects whose type is completely unrelated to the target - only fetches
   *  the index buckets that match, contain, or are missing a type; never the whole list. */
  private getCandidatePool(targetType: string): ProjectMetadataRecord[] {
    const targetKey = targetType.trim().toLowerCase();
    const pool: ProjectMetadataRecord[] = [];

    for (const [key, bucket] of this.projectTypeIndex.entries()) {
      const isRelated = key === targetKey || key.includes(targetKey) || targetKey.includes(key) || key === "unknown";
      if (isRelated) pool.push(...bucket);
    }

    return pool;
  }

  // --- Scoring ----------------------------------------------------------

  /**
   * Weighted average of the 5 factors, each only included if the candidate actually has
   * that data point - a candidate missing e.g. city or buildingGrade has its score
   * computed from the remaining weight, renormalized, rather than being compared against
   * a fabricated default. Returns 0-100.
   */
  private scoreProject(profile: ProjectProfileInput, candidate: ProjectMetadataRecord): number {
    let weightedSum = 0;
    let weightUsed = 0;

    if (candidate.projectType) {
      const candidateType = candidate.projectType.trim().toLowerCase();
      const targetType = profile.projectType.trim().toLowerCase();
      const typeScore =
        candidateType === targetType ? 1 : candidateType.includes(targetType) || targetType.includes(candidateType) ? 0.6 : 0;
      weightedSum += typeScore * this.weights.projectType;
      weightUsed += this.weights.projectType;
    }

    if (candidate.projectCost !== undefined && candidate.projectCost > 0 && profile.projectCost > 0) {
      const diff = Math.abs(profile.projectCost - candidate.projectCost);
      const costScore = Math.max(0, 1 - diff / profile.projectCost);
      weightedSum += costScore * this.weights.projectCost;
      weightUsed += this.weights.projectCost;
    }

    if (candidate.projectSize !== undefined && candidate.projectSize > 0 && profile.projectSize > 0) {
      const diff = Math.abs(profile.projectSize - candidate.projectSize);
      const sizeScore = Math.max(0, 1 - diff / profile.projectSize);
      weightedSum += sizeScore * this.weights.projectSize;
      weightUsed += this.weights.projectSize;
    }

    if (candidate.city) {
      const cityScore = candidate.city.trim().toLowerCase() === profile.city.trim().toLowerCase() ? 1 : 0;
      weightedSum += cityScore * this.weights.city;
      weightUsed += this.weights.city;
    }

    if (candidate.buildingGrade) {
      const gradeScore = candidate.buildingGrade.trim().toLowerCase() === profile.buildingGrade.trim().toLowerCase() ? 1 : 0;
      weightedSum += gradeScore * this.weights.buildingGrade;
      weightUsed += this.weights.buildingGrade;
    }

    if (weightUsed === 0) return 0;
    return Math.round((weightedSum / weightUsed) * 1000) / 10;
  }

  // --- Public query -------------------------------------------------------

  async findTopSimilarProjects(
    profile: ProjectProfileInput,
    topN: number = DEFAULT_TOP_N
  ): Promise<ProjectSimilarityQueryResult> {
    await this.ensureIndex();

    const candidatePool = this.getCandidatePool(profile.projectType);

    const results: ProjectSimilarityResult[] = candidatePool
      .map((candidate) => ({
        projectId: candidate.projectId,
        projectName: candidate.projectName,
        projectCost: candidate.projectCost,
        projectSize: candidate.projectSize,
        projectType: candidate.projectType,
        city: candidate.city,
        buildingGrade: candidate.buildingGrade,
        similarityScore: this.scoreProject(profile, candidate)
      }))
      .filter((result) => result.similarityScore > 0)
      .sort((a, b) => b.similarityScore - a.similarityScore)
      .slice(0, topN);

    return {
      results,
      fallbackRecommendation: results.length === 0 ? "basic-rate" : "none"
    };
  }
}
