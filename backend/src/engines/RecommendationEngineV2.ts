/**
 * RecommendationEngineV2 (implemented)
 *
 * Pure orchestrator. It never parses an engineering description itself, never searches
 * the Master BOQ catalog directly (it has no dependency on IKnowledgeBaseEngine at all -
 * only HistoricalRateEngine/BasicRateEngine/ProjectSimilarityEngine may touch the
 * catalog), never scores project similarity itself, and never performs a UOM conversion
 * itself. Every one of those is delegated to its dedicated engine; this file only
 * sequences the calls and applies the six recommendation decision rules.
 *
 * Recommendation Engine V1 (src/RecommendationEngineV2.ts, at the repository root) is
 * untouched and continues to serve the live application. This class is not wired into
 * server.ts, any route, the Dashboard, Export, or Workbook Preservation - implementation
 * only, per instruction.
 */

import type { IEngineeringParser, EngineeringItem } from "./EngineeringParser.js";
import type { IProjectSimilarityEngine, ProjectProfileInput, ProjectSimilarityResult } from "./ProjectSimilarityEngine.js";
import type { IHistoricalRateEngine, HistoricalRateResult, HistoricalMatchType } from "./HistoricalRateEngine.js";
import type { IBasicRateEngine, BasicRateResult } from "./BasicRateEngine.js";
import type { IUOMEngine, UOMConversionResult } from "./UOMEngine.js";
import type { IConfidenceEngine, ConfidenceFactors, ConfidenceMatchType } from "./ConfidenceEngine.js";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface RFQLineItem {
  id: string;
  description: string;
  worksheetName?: string;
  uom?: string;
  quantity?: number;
  rate?: number;
  amount?: number;
}

export interface RFQ {
  id: string;
  projectName: string;
  items: RFQLineItem[];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type RecommendationStatus = "RECOMMENDED" | "ENGINEERING_REVIEW_REQUIRED";
export type RecommendationSource = "HISTORICAL_RATE" | "BASIC_RATE" | "NONE";
export type UOMStatus = "same-unit" | "converted" | "incompatible";

export interface RecommendationResult {
  rfqItem: RFQLineItem;
  recommendationStatus: RecommendationStatus;
  recommendationSource: RecommendationSource;
  recommendedRate?: number;
  sourceProject?: string;
  sourceWorksheet?: string;
  historicalItem?: string;
  historicalRate?: number;
  basicRate?: number;
  matchType: HistoricalMatchType;
  uomStatus: UOMStatus;
  confidence?: number;
  engineeringReviewRequired: boolean;
  /** Always states which of the six Decision Rules fired, satisfying "Decision Rule used"
   *  traceability without adding a field beyond the exact OUTPUT shape given. */
  explanation: string;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface IRecommendationEngineV2 {
  /**
   * Single-item pipeline. Takes the Top 5 Similar Projects as a parameter rather than
   * resolving them itself, so a caller processing many items never triggers a duplicate
   * ProjectSimilarityEngine call for the same Project Profile.
   */
  recommendItem(item: RFQLineItem, topSimilarProjects: ProjectSimilarityResult[]): Promise<RecommendationResult>;

  /** Full pipeline for an entire RFQ: resolves Top 5 Similar Projects once, then processes
   *  every item in parallel. */
  recommendBatch(rfq: RFQ, projectProfile: ProjectProfileInput): Promise<RecommendationResult[]>;
}

// ---------------------------------------------------------------------------
// Internal decision-rule outcome shape
// ---------------------------------------------------------------------------

interface DecisionOutcome {
  status: RecommendationStatus;
  source: RecommendationSource;
  recommendedRate?: number;
  sourceProject?: string;
  sourceWorksheet?: string;
  historicalItem?: string;
  historicalRate?: number;
  engineeringReviewRequired: boolean;
  confidenceMatchType: ConfidenceMatchType;
  matchScore?: number;
  explanation: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class RecommendationEngineV2 implements IRecommendationEngineV2 {
  constructor(
    private readonly engineeringParser: IEngineeringParser,
    private readonly projectSimilarity: IProjectSimilarityEngine,
    private readonly historicalRateEngine: IHistoricalRateEngine,
    private readonly basicRateEngine: IBasicRateEngine,
    private readonly uomEngine: IUOMEngine,
    private readonly confidenceEngine: IConfidenceEngine
  ) {}

  async recommendBatch(rfq: RFQ, projectProfile: ProjectProfileInput): Promise<RecommendationResult[]> {
    // Step 2, once for the whole RFQ - never per item, to avoid duplicate engine calls.
    const similarity = await this.projectSimilarity.findTopSimilarProjects(projectProfile);
    const topSimilarProjects = similarity.results;

    // Support parallel processing: every item's pipeline is independent once
    // topSimilarProjects is known, so all items run concurrently.
    return Promise.all(rfq.items.map((item) => this.recommendItemSafely(item, topSimilarProjects)));
  }

  async recommendItem(item: RFQLineItem, topSimilarProjects: ProjectSimilarityResult[]): Promise<RecommendationResult> {
    // Step 1
    const engineeringItem = this.parseItem(item);

    // Steps 3 & 4 run concurrently - HistoricalRateEngine and BasicRateEngine are
    // independent of each other, both independent of UOMEngine, so there is no reason to
    // serialize them.
    const [historicalResult, basicRateResult] = await Promise.all([
      this.historicalRateEngine.findHistoricalRates({ engineeringItem, topSimilarProjects }),
      this.basicRateEngine.findBasicRate({ engineeringItem })
    ]);

    // Step 5
    const bestHistoricalCandidate = historicalResult.candidates[0];
    const uomResult = this.uomEngine.analyzeEngineeringItem({
      engineeringItem,
      historicalMatch: bestHistoricalCandidate,
      basicRateMatch: basicRateResult.found ? basicRateResult : undefined
    });

    // Step 6
    const decision = this.applyDecisionRules(historicalResult, basicRateResult);

    // Step 7 - confidence is computed by ConfidenceEngine, never by this class.
    const confidence =
      decision.status === "ENGINEERING_REVIEW_REQUIRED"
        ? undefined
        : this.confidenceEngine.computeConfidence(this.buildConfidenceFactors(decision, historicalResult, topSimilarProjects, uomResult));

    return {
      rfqItem: item,
      recommendationStatus: decision.status,
      recommendationSource: decision.source,
      recommendedRate: decision.recommendedRate,
      sourceProject: decision.sourceProject,
      sourceWorksheet: decision.sourceWorksheet,
      historicalItem: decision.historicalItem,
      historicalRate: decision.historicalRate,
      basicRate: basicRateResult.found ? basicRateResult.basicRate : undefined,
      matchType: historicalResult.matchType,
      uomStatus: this.deriveUOMStatus(uomResult),
      confidence: confidence?.score,
      engineeringReviewRequired: decision.engineeringReviewRequired,
      explanation: confidence ? `${decision.explanation} ${confidence.explanation}` : decision.explanation
    };
  }

  // --- Step 1 ---------------------------------------------------------------

  private parseItem(item: RFQLineItem): EngineeringItem {
    return this.engineeringParser.parse({
      originalDescription: item.description,
      worksheetName: item.worksheetName,
      uom: item.uom,
      quantity: item.quantity,
      rate: item.rate,
      amount: item.amount
    });
  }

  // --- Step 6: Decision Rules -------------------------------------------------

  private applyDecisionRules(historicalResult: HistoricalRateResult, basicRateResult: BasicRateResult): DecisionOutcome {
    const bestCandidate = historicalResult.candidates[0];

    switch (historicalResult.matchType) {
      case "EXACT_MATCH":
        return {
          status: "RECOMMENDED",
          source: "HISTORICAL_RATE",
          recommendedRate: historicalResult.bestHistoricalRate,
          sourceProject: historicalResult.sourceProject,
          sourceWorksheet: historicalResult.worksheet,
          historicalItem: bestCandidate?.historicalItemDescription,
          historicalRate: historicalResult.bestHistoricalRate,
          engineeringReviewRequired: false,
          confidenceMatchType: "EXACT_MATCH",
          matchScore: bestCandidate?.matchScore,
          explanation: `Decision Rule 1 (EXACT_MATCH): identical engineering item found in "${historicalResult.sourceProject}" - recommending its historical rate directly.`
        };

      case "SPECIFICATION_MATCH":
        return {
          status: "RECOMMENDED",
          source: "HISTORICAL_RATE",
          recommendedRate: historicalResult.bestHistoricalRate,
          sourceProject: historicalResult.sourceProject,
          sourceWorksheet: historicalResult.worksheet,
          historicalItem: bestCandidate?.historicalItemDescription,
          historicalRate: historicalResult.bestHistoricalRate,
          engineeringReviewRequired: false,
          confidenceMatchType: "SPECIFICATION_MATCH",
          matchScore: bestCandidate?.matchScore,
          explanation: `Decision Rule 2 (SPECIFICATION_MATCH): matched item in "${historicalResult.sourceProject}" shares material and specification, but the engineering specification is not identical - recommending its historical rate; specification difference flagged.`
        };

      case "MATERIAL_MATCH":
        return {
          status: "RECOMMENDED",
          source: "HISTORICAL_RATE",
          recommendedRate: historicalResult.bestHistoricalRate,
          sourceProject: historicalResult.sourceProject,
          sourceWorksheet: historicalResult.worksheet,
          historicalItem: bestCandidate?.historicalItemDescription,
          historicalRate: historicalResult.bestHistoricalRate,
          engineeringReviewRequired: true,
          confidenceMatchType: "MATERIAL_MATCH",
          matchScore: bestCandidate?.matchScore,
          explanation: `Decision Rule 3 (MATERIAL_MATCH): only the material matched a historical item in "${historicalResult.sourceProject}" (specification/grade/dimensions unconfirmed) - recommending its historical rate, marked for engineering review.`
        };

      case "PARTIAL_MATCH":
        return {
          status: "RECOMMENDED",
          source: "HISTORICAL_RATE",
          recommendedRate: historicalResult.bestHistoricalRate,
          sourceProject: historicalResult.sourceProject,
          sourceWorksheet: historicalResult.worksheet,
          historicalItem: bestCandidate?.historicalItemDescription,
          historicalRate: historicalResult.bestHistoricalRate,
          engineeringReviewRequired: true,
          confidenceMatchType: "PARTIAL_MATCH",
          matchScore: bestCandidate?.matchScore,
          explanation: `Decision Rule 4 (PARTIAL_MATCH): only weak attribute overlap (brand/execution method/UOM) found in "${historicalResult.sourceProject}" - recommending its historical rate with reduced confidence.`
        };

      case "NO_MATCH":
      default:
        if (basicRateResult.found) {
          return {
            status: "RECOMMENDED",
            source: "BASIC_RATE",
            recommendedRate: basicRateResult.basicRate,
            sourceProject: basicRateResult.sourceProject,
            sourceWorksheet: basicRateResult.worksheet,
            engineeringReviewRequired: false,
            confidenceMatchType: "BASIC_RATE",
            matchScore: basicRateResult.matchScore,
            explanation: `Decision Rule 5 (NO_MATCH + Basic Rate exists): no historical project match was found - recommending the recorded Basic Rate from "${basicRateResult.sourceProject}" instead.`
          };
        }

        return {
          status: "ENGINEERING_REVIEW_REQUIRED",
          source: "NONE",
          engineeringReviewRequired: true,
          confidenceMatchType: "NO_MATCH",
          explanation: "Decision Rule 6 (NO_MATCH + no Basic Rate): no historical match and no Basic Rate exist for this item. No rate has been invented or estimated - engineering review is required."
        };
    }
  }

  // --- Step 7 support ---------------------------------------------------------

  private buildConfidenceFactors(
    decision: DecisionOutcome,
    historicalResult: HistoricalRateResult,
    topSimilarProjects: ProjectSimilarityResult[],
    uomResult: UOMConversionResult
  ): ConfidenceFactors {
    const isHistorical = decision.source === "HISTORICAL_RATE";
    const projectSimilarityScore = isHistorical
      ? topSimilarProjects.find((p) => p.projectId === historicalResult.candidates[0]?.historicalProjectId)?.similarityScore
      : undefined;

    return {
      matchType: decision.confidenceMatchType,
      matchScore: decision.matchScore,
      projectSimilarityScore,
      candidateCount: isHistorical ? historicalResult.candidates.length : undefined,
      uomCompatible: uomResult.compatible,
      uomConversionApplied: uomResult.conversionApplied
    };
  }

  private deriveUOMStatus(uomResult: UOMConversionResult): UOMStatus {
    if (!uomResult.compatible) return "incompatible";
    return uomResult.conversionApplied ? "converted" : "same-unit";
  }

  // --- Error handling: one item's failure never stops the batch ---------------

  private async recommendItemSafely(item: RFQLineItem, topSimilarProjects: ProjectSimilarityResult[]): Promise<RecommendationResult> {
    try {
      return await this.recommendItem(item, topSimilarProjects);
    } catch (error) {
      console.error(
        `[RecommendationEngineV2] Failed to process RFQ item "${item.id}" (non-fatal - continuing with remaining items):`,
        error
      );
      return {
        rfqItem: item,
        recommendationStatus: "ENGINEERING_REVIEW_REQUIRED",
        recommendationSource: "NONE",
        matchType: "NO_MATCH",
        uomStatus: "incompatible",
        engineeringReviewRequired: true,
        explanation: `Processing failed for this item (${error instanceof Error ? error.message : String(error)}) - flagged for engineering review.`
      };
    }
  }
}
