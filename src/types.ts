export enum Domain {
  Civil = "Civil",
  Interior = "Interior",
  Electrical = "Electrical",
  Mechanical = "Mechanical"
}

export interface HistoricalBOQ {
  id: string;
  projectName: string;
  contractorName: string;
  fileName: string;
  uploadDate: string;
  domains: Domain[];
  itemCount: number;

  // Enterprise Ingestion Enhancements
  client?: string;
  location?: string;
  projectType?: string;
  projectSize?: string; // e.g. "150,000 sq ft"
  projectYear?: string; // e.g. "2025"
  version?: string; // e.g. "v1.0"
  worksheetsCount?: number;
  worksheetsList?: string[];
  generalNotesSummary?: string;
  preamblesSummary?: string;
  rateStructure?: string; // e.g. "Unified Base + Premium"
  commercialMarginApplied?: number; // e.g. 15 for +15%
}

export interface DeterministicRowMapping {
  historicalProjectId: string;
  worksheetName: string;
  worksheetIndex: number;
  rowNumber: number;
  excelRowIndex: number;
  excelColumnIndex?: number;
  originalItemDescription: string;
  quantityCellAddress: string;
  unitRateCellAddress: string;
  amountCellAddress: string;
  originalQuantity: number;
  originalUnitRate: number;
  originalAmount: number;
  uom: string;
  masterItemId: string;
}

export interface HistoricalVariation {
  id: string;
  boqId: string;
  projectName: string;
  contractorName: string;
  originalDescription: string;
  originalUnit: string;
  originalRate: number;
  originalSpecification?: string;
  originalGeneralNotes?: string;
}

export interface ProjectContext {
  projectType: string;         // e.g. "Commercial Office", "Residential High-Rise"
  projectCategory: string;     // e.g. "Fitout", "New Construction"
  industry: string;            // e.g. "Information Technology", "Real Estate"
  client: string;              // e.g. "Google", "DLF"
  location: string;            // e.g. "Gurugram, India", "Bangalore, India"
  projectSize: string;         // e.g. "120,000 sq ft"
  projectCost?: string;        // e.g. "₹1,50,00,000"
  buildingType: string;        // e.g. "Grade A Commercial"
  fitoutType: string;          // e.g. "Premium Corporate"
  constructionType: string;    // e.g. "RCC Frame Structure"
  executionMethod: string;     // e.g. "Item Rate Tender"
  tenderType: string;          // e.g. "Public Competitive"
  commercialConditions: string;// e.g. "Mobilization advance 10%, Retention 5%"
  applicableStandards: string[]; // e.g. ["IS: 1200", "CPWD Specifications"]
}

export interface WorksheetContext {
  sheetName: string;
  domain: Domain;
  subDomain: string;           // e.g. "Structured Cabling", "Wet Walls"
  executionScope: string;      // e.g. "Supply & Installation", "Installation Only"
  commercialScope: string;     // e.g. "Excludes taxes, includes waste"
  measurementMethod: string;   // e.g. "IS: 1200 Part 15"
  rateStructure: string;       // e.g. "Supply Rate + Labor Rate + Profit"
  dependencies: string[];      // e.g. "Slab casting complete", "Power supply active"
}

export interface ItemDecomposition {
  activity: string;            // e.g. "Excavation", "Concreting", "Laying Tiles"
  material: string;            // e.g. "Burnt clay bricks", "BWR Plywood"
  specification: string;       // e.g. "12.5mm Gypsum board conforming to IS: 2095"
  thickness?: number;          // in mm
  diameter?: number;           // in mm
  capacity?: number;           // in Watts or Tons
  width?: number;              // in mm
  height?: number;             // in mm
  grade?: string;              // e.g. "M25", "Fe500"
  mixRatio?: string;           // e.g. "1:2:4", "1:6"
  brand?: string;              // e.g. "Asian Paints", "Hettich"
  finish?: string;             // e.g. "Laminate", "Emulsion"
  executionMethod: string;     // e.g. "Mechanical/Manual", "Flush laying"
  fixingMethod: string;        // e.g. "Recessed ceiling suspension", "Lead jointing"
  measurementMethod: string;   // e.g. "Net volume", "Area flat"
  commercialScope: string;     // e.g. "Supply and Installation", "Supply Only"
  rateStructure: string;       // e.g. "Compound rate inclusive of centering and shuttering"
  engineeringDependencies: string[]; // e.g. ["FRAME_COMPLETED", "PUTTY_COAT_APPLIED"]
}

export interface MasterBOQItem {
  id: string;
  standardDescription: string;
  domain: Domain;
  subcategory: string;
  standardUnit: string;
  historicalDescriptions: string[];
  historicalSpecifications: string[];
  historicalGeneralNotes: string[];
  historicalRates: number[];
  averageRate: number;
  medianRate: number;
  minRate: number;
  maxRate: number;
  latestRate: number;
  projects: string[];
  companies: string[];
  occurrenceCount: number;
  confidenceMetadata?: number;
  dimensions?: any;
  // Expanded Normalization metadata
  canonicalName?: string;
  aliases?: string[];
  rateTypes?: {
    material?: number;
    labor?: number;
    machinery?: number;
    overhead?: number;
  };
  itemDecomposition?: ItemDecomposition;
  historicalWorksheets?: string[];
  historicalRows?: number[];
  historicalCells?: string[];

  // Data-quality quarantine (Audit 0002 fix 2): historical rates rejected at
  // precompute time as order-of-magnitude outliers against this master item's own
  // sibling rates (median/MAD test). Kept here - never silently dropped - so the
  // corruption is visible/auditable, but excluded from historicalRates and every
  // downstream evidence pool.
  quarantinedRates?: { rate: number; projectName: string; reason: string }[];
  
  // Precomputed features for performance
  precomputedActivity?: string;
  precomputedMaterial?: string;
  precomputedSpecification?: string;
  precomputedBrand?: string;
  precomputedGrade?: string;
  precomputedThickness?: number;
  precomputedCapacity?: number;
  precomputedVoltage?: number;
  precomputedPipeDiameter?: number;
  precomputedDimensions?: string;
  precomputedFinish?: string;
  precomputedExecutionMethod?: string;
  precomputedUOM?: string;

  precomputedHistoricalProjects?: string[];
  precomputedHistoricalRates?: number[];
  precomputedSupplyRates?: number[];
  precomputedInstallationRates?: number[];
  precomputedHistoricalAmounts?: number[];

  precomputedMedian?: number;
  precomputedWeightedMedian?: number;
  precomputedMean?: number;
  precomputedQuartiles?: { q1: number; q3: number };
  precomputedOutlierLimits?: { lower: number; upper: number };
  precomputedEmbeddings?: number[];
  precomputedProjectMetadata?: any;
  precomputedTokens?: string[];

  // Permanent Knowledge Base Indexed Master BOQ Fields
  masterItemId?: string;
  canonicalDescription?: string;
  originalDescription?: string;
  category?: string;
  engineeringActivity?: string;
  material?: string;
  specification?: string;
  brand?: string;
  grade?: string;
  thickness?: number;
  capacity?: number;
  finish?: string;
  executionMethod?: string;
  uom?: string;
  supplyRate?: number[];
  installationRate?: number[];
  median?: number;
  weightedMedian?: number;
  quartiles?: { q1: number; q3: number };
  outlierLimits?: { lower: number; upper: number };
  historicalProjects?: string[];
  projectType?: string[];
  city?: string[];
  buildingType?: string[];
  embeddingVector?: number[];
  keywords?: string[];
  stemmedTokens?: string[];
  basicRate?: number;
}

export interface PreambleData {
  id: string;
  boqId: string;
  projectName: string;
  rawText: string;
  specifications: {
    material?: string;
    thickness?: string;
    grade?: string;
    density?: string;
    brandRequirements?: string;
    mortarRatio?: string;
    concreteGrade?: string;
    steelGrade?: string;
    finish?: string;
    paintCoats?: string;
    standards?: string;
    inclusions?: string[];
    exclusions?: string[];
  };
}

export interface RFQ {
  id: string;
  projectName: string;
  fileName: string;
  uploadDate: string;
  domains: Domain[];
  itemCount: number;
  status: "Draft" | "Analyzing" | "Rated";
  preamblePasted?: string;
  preambleExtracted?: PreambleData;

  // Enterprise Context
  projectContext?: ProjectContext;
  worksheetContexts?: Record<string, WorksheetContext>;
  kbVersion?: string;
  workbookBlueprint?: WorkbookBlueprint;

  // Profiling performance fields
  parseTimeMs?: number;
  retrievalTimeMs?: number;
  recommendationTimeMs?: number;

  // Universal BOQ Upload Parser diagnostics (src/BOQParserEngine.ts) - additive, informational
  // only. Never affects recommendation, pricing, or export logic.
  uploadLog?: {
    workbookRead: boolean;
    worksheetsFound: string[];
    worksheetsParsed: string[];
    worksheetsSkipped: { sheetName: string; reason: string }[];
    totalRowsParsed: number;
    totalRowsSkipped: number;
    skippedReasonSummary: Record<string, number>;
    headerDetectionResults: { sheetName: string; headerRows: number[]; columns: { description: number | null; quantity: number | null; unit: number | null; rate: number | null; amount: number | null; itemNo: number | null }[] }[];
    parsingTimeMs: number;
    warnings: string[];
    errors: string[];
    diagnostics?: { category: "Metadata Warning" | "Parsing Error" | "Workbook Corruption" | "Missing BOQ Data"; sheetName?: string; message: string }[];
    metadataWarning?: string;
    definedNamesRemoved?: number;
  };

  /**
   * Per-RFQ recommendation quality summary - a pure READ of every item's
   * CommercialDecision (ADR-0001), computed by the shared approval-metrics helper.
   * Contains no independent judgment of its own.
   */
  recommendationAuditReport?: {
    approvalAccuracy: number;   // % of rated items Auto Approved
    totalRows: number;
    autoApprovedRows: number;
    needsReviewRows: number;
    manualPricingRows: number;
    records: {
      worksheetName: string;
      rowNumber: number;
      originalDescription: string;
      masterItemId: string;
      recommendedRate: number;
      approvalStatus: ApprovalStatus;
      reasonCode: DecisionReasonCode;
    }[];
  };

  // Task 8 (Self Validation) - one entry per item that was flagged as weakly-supported/high-
  // deviation/heavily-extrapolated and automatically re-evaluated via Progressive Matching before
  // the BOQ was finalized. Kept for debugging/audit and future UI use, per the "explainability"
  // requirement - never itself read by pricing or export logic. See server.ts's self-validation
  // second pass, right after Project Calibration.
  selfValidationReport?: {
    itemId: string;
    rowNum: number;
    reasons: string[];
    adopted: boolean;
    detail: string;
  }[];
}

// =========================================================
// COMMERCIAL DECISION (ADR-0001 Single Source of Truth)
// =========================================================

/**
 * The one approval vocabulary, end to end. These are exactly the three buckets the
 * dashboard displays (plus "Pending" for not-yet-rated items). The legacy
 * "Accepted"/"Needs Manual Review" vocabulary and the auditor's "VERIFIED"/"NEW_ITEM"
 * relabeling are retired - every module reads this one field.
 */
export type ApprovalStatus = "Pending" | "Auto Approved" | "Needs Review" | "Manual Pricing";

export type DecisionReasonCode =
  | "NOT_RATED"            // recommendation has not run for this item yet
  | "ESTIMATOR_OVERRIDE"   // a human approved a rate; their decision is final
  | "NO_EVIDENCE"          // zero historical/engineering evidence of any kind -> price manually
  | "LOW_CONFIDENCE"       // confidence below CONFIDENCE_APPROVAL_THRESHOLD
  | "VALIDATION_FAILED"    // one or more validation categories failed
  | "LOW_CONFIDENCE_AND_VALIDATION_FAILED"
  | "APPROVED";            // confidence and validation both clear

/**
 * The single, immutable Recommendation Object (ADR-0001). Assembled exactly once per
 * item by src/CommercialDecisionEngine.ts after the pricing chain (baseline ->
 * engineering adjustment -> progressive matching -> calibration -> self-validation)
 * has fully finished. It is the ONLY place approval is decided; every downstream
 * surface renders it read-only. Deep evidence lives on the item itself
 * (marketRateStatistics, engineeringAdjustment, recommendationTrace, validationResults,
 * confidence facets) - this object records the interpretation of that evidence.
 */
export interface CommercialDecision {
  recommendationId: string;          // the RFQ item id this decision belongs to
  recommendedRate: number;           // final rate at decision time
  selectedHistoricalRate?: number;   // marketRateStatistics.selectedRate, when evidence exists
  approvalStatus: ApprovalStatus;
  reasonCode: DecisionReasonCode;
  decisionSummary: string;           // human-readable one-liner, safe for direct UI display
  confidence: number;                // the confidence value the approval rule used
  evidenceStrength: "None" | "Weak" | "Moderate" | "Strong";
  acceptedEvidenceCount: number;     // selected + corroborating historical references
  rejectedEvidenceCount: number;     // discarded at retrieval or selection time
  failedValidations: string[];       // names of failed validation categories, [] if all pass
  rateProvenance: string;            // which pipeline stage produced the final rate
}

export interface RFQItem {
  id: string;
  rfqId: string;
  domain: Domain;
  rowNum: number;
  sheetName: string;
  itemNo: string;
  originalDescription: string;
  unit: string;
  quantity: number;
  recommendedRate: number;
  overriddenRate?: number;
  isOverridden: boolean;
  matchedMasterId?: string;

  // Installation Rate (additive layer on top of the existing Supply Rate recommendation -
  // see src/InstallationRateEngine.ts. Never affects recommendedRate/matchedMasterId above.)
  // Always computed as Recommended Supply x Final Installation % - the domain baseline is the
  // anchor; historical data can only blend with it (within tolerance) or gets ignored outright.
  installationRate?: number;
  installationSource?: "Baseline" | "Blended" | "Historical Ignored";
  installationPercentage?: number; // the Final Installation % actually used, e.g. 0.15 for 15%
  installationReferenceCount?: number; // historical occurrences considered (0 if none/ignored)

  // Engineering Adjustment (additive layer on top of the existing "Basic Rate" fallback path -
  // see src/EngineeringAdjustmentEngine.ts. Only ever runs when no exact historical item exists;
  // never touches an exact-match "Historical Rate" recommendation.) When applied, recommendedRate
  // above is overwritten with the engineering-adjusted estimate rather than a flat catalog guess.
  engineeringAdjustment?: {
    applied: boolean;
    mathematicalModel: "Linear Interpolation" | "Linear Extrapolation" | "Area Scaling" | "Volume Scaling" | "Historical Regression" | "None";
    engineeringParameters: { name: string; value: number; unit: string }[];
    familyKey: string;
    historicalReferencesUsed: { description: string; dimensionValue: number; rate: number }[];
    calculatedAdjustment: string;
    confidence: number;
    isExtrapolation: boolean;
    rateVariationPercent: number | null;
    explanation: string;
  };
  // Dashboard "Items Requiring Attention" trigger flags, e.g. "Low Confidence", "AI Estimated",
  // "New Dimension", "New Specification", "Engineering Review Required", "Manual Pricing Required",
  // "UOM Conversion", "High Historical Rate Variation", "Limited Historical References".
  attentionFlags?: string[];

  // Project Calibration & Validation Layer (additive, runs AFTER all of the above - see
  // src/ProjectCalibrationEngine.ts. Only overwrites recommendedRate for the small subset of
  // items that are simultaneously high project-cost contribution, high deviation from their own
  // item-level market rate statistics, and low pricing confidence, and only when the whole
  // project estimate falls outside the expected historical cost range. Everything else is
  // reported here purely for validation and never changes recommendedRate.)
  // Confidence Engine redesign - six independent dimensions replacing a single confidence score.
  // See src/ProjectCalibrationEngine.ts computeItemConfidenceProfile for definitions. Never
  // affects business logic, pricing logic, or recommendation logic (item.status) - purely a
  // richer confidence report for estimator triage.
  semanticConfidence?: number;
  specificationConfidence?: number;
  pricingConfidence?: number;
  engineeringConfidence?: number;
  historicalConfidence?: number;
  overallConfidence?: number;
  // Historical evidence outcome for this item (src/ProjectCalibrationEngine.ts's
  // MarketRateStatistics) - a filtered, selected piece of engineering evidence, never a
  // statistical distribution. Field/interface names kept for minimal churn even though nothing
  // here is a statistic - see that file's header comment.
  marketRateStatistics?: {
    min: number;
    max: number;
    referenceCount: number;
    selectedRate: number;
    representativeRate: number;
    corroboratingCount: number;
    secondBestRateDeviationPercent: number | null;
    selectedMatchScore: number;
    rejectedCount: number;
    rejectedBreakdown: { reason: string; count: number }[];
    learningAdjustmentPercent?: number | null;
    learningReason?: string | null;
    // Explainability: one row per historical project that survived filtering - `selected` marks
    // the single observation the recommendation was taken from; the rest are shown only as
    // corroborating evidence, never blended into the rate.
    historicalEvidence?: {
      projectName: string;
      projectSimilarity: number;
      itemSimilarity: number;
      specificationSimilarity: number;
      historicalRate: number;
      selected: boolean;
      corroborating: boolean;
      section: string;
      historicalDate: string;
    }[];
    // Which historical items were discarded, and why (Step 7 explainability) - combines
    // HistoricalRetrievalEngine's retrieval-time rejections with this engine's own pre-filters.
    rejectedEvidence?: { standardDescription: string; projectName: string; reason: string }[];
  };
  calibrationApplied?: boolean;
  calibrationReason?: string;
  // Step 7 (Explainability): historical items considered but discarded during retrieval (semantic/
  // UOM/commercial-equivalence gates), before market-rate selection even runs. See
  // src/HistoricalRetrievalEngine.ts's rejectedCandidates.
  rejectedHistoricalCandidates?: { standardDescription: string; projectName: string; reason: string }[];

  // Historical Retrieval redesign (additive - see src/HistoricalRetrievalEngine.ts). Ranked list
  // of historical candidates surviving Domain/Item Family/UOM filtering and multi-factor
  // similarity scoring. Deliberately NOT auto-applied to recommendedRate by this engine itself -
  // it is handed to the pricing engine (ProjectCalibrationEngine) to weight its market-rate
  // statistics, and kept here purely for transparency/audit.
  historicalCandidates?: {
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
  }[];

  confidenceScore: number; // percentage, e.g. 85
  reason: string;
  parentHierarchy: string[]; // e.g. ["Civil Works", "Flooring", "Granite Flooring"]
  /**
   * THE approval decision for this item - written exclusively by
   * src/CommercialDecisionEngine.ts (ADR-0001). Every consumer (dashboard buckets,
   * table/drawer badges, auditor, export filter, accuracy metrics) reads this field;
   * nothing else may derive its own approval opinion from confidence/validation.
   */
  approvalStatus: ApprovalStatus;
  /**
   * The full Commercial Decision - the single, immutable (frozen) record of WHY
   * approvalStatus is what it is. Assembled once per item by
   * CommercialDecisionEngine.finalizeItemDecision after the pricing chain completes.
   */
  decision?: CommercialDecision;
  dimensions?: {
    thickness?: number;
    diameter?: number;
    capacity?: number;
    width?: number;
    height?: number;
    grade?: string;
    mixRatio?: string;
  };

  // Enterprise Intelligence Fields
  itemDecomposition?: ItemDecomposition;

  // Progressive Relaxation Matching (src/ProgressiveMatchingEngine.ts) - set only for items with
  // no direct historical match, labelling which relaxed tier produced the estimate (e.g.
  // "Material Match") so the dashboard can show a genuinely new/unseen item was estimated via
  // broader market inference rather than a direct historical hit.
  matchTier?: "Specification Match" | "Material Match" | "Functional Match" | "Market Estimation";
  // Task 5 (Commercial Validation) - real per-item pass/fail checks, computed in server.ts's
  // buildItemValidationResults from data the recommendation pipeline already produced (market
  // statistics, confidence profile, engineering adjustment, UOM compatibility). Shape matches
  // exactly what src/components/RecommendationsTab.tsx's Self-Validation Auditor drawer renders.
  validationResults?: {
    engineeringValidation: { pass: boolean; details: string };
    specificationValidation: { pass: boolean; details: string };
    commercialValidation: { pass: boolean; details: string };
    uomValidation: { pass: boolean; details: string };
    historicalValidation: { pass: boolean; details: string };
    workbookValidation: { pass: boolean; details: string };
    regressionValidation: { pass: boolean; details: string };
  };
  recommendationTrace?: {
    rfqItem: string;
    historicalProject: string;
    historicalProjectID?: string;
    historicalRow?: number;
    historicalWorksheet: string;
    historicalCell: string;
    historicalUnitRate: number;
    recommendedUnitRate: number;
    matchType?: string;
    explanation?: string;
    historicalProjectCost?: number;
    historicalProjectType?: string;
    rateSource?: string;
    /**
     * The baseline stage's original explanation, preserved verbatim the first time a
     * later pricing stage overwrites the rate (Audit 0002 fix 4). `explanation` above is
     * reconciled by CommercialDecisionEngine.finalizeItemDecision to describe the stage
     * that actually produced the final rate; this field keeps the baseline lineage
     * visible without the trace ever contradicting the final decision.
     */
    baselineExplanation?: string;
  };
}

export interface Settings {
  similarityThreshold: number; // e.g. 0.65
  aboveAverageBuffer: number; // e.g. 15 (for percentage buffer, i.e. +15%)
  activeModel: string; // "gemini-3.5-flash"
  weights: {
    semantic: number;
    hierarchy: number;
    specification: number;
    preamble: number;
    unit: number;
  };
}

export interface DashboardMetrics {
  historicalBOQsCount: number;
  masterBOQCount: number;
  activeRFQsCount: number;
  averageConfidence: number;
  domainDistribution: Record<Domain, number>;
  learningAccuracyHistory: { turn: number; accuracy: number }[];
  costIndexTrend: { month: string; Civil: number; Interior: number; Electrical: number; Mechanical: number }[];
}

export interface ExportHistoryItem {
  id: string;
  projectName: string;
  rfqName: string;
  exportDate: string;
  user: string;
  workbookVersion: string;
  recommendationMode: "Heuristic" | "AI Hybrid" | "Historical Replay";
  historicalReplayDetected: boolean;
  validationResult: "Passed" | "Warnings" | "Failed";
  fileName: string;
}

// Learning Layer - one record per estimator correction (POST /api/rfqs/:id/override). Captured
// as a permanent, append-only log so the recommendation engine can improve automatically as more
// projects are added, without ever being told to. See src/LearningEngine.ts.
export interface LearningEvent {
  id: string;
  timestamp: string;
  rfqId: string;
  itemId: string;
  masterId?: string;
  domain: string;
  originalRecommendation: number;
  approvedRate: number;
  difference: number;       // approvedRate - originalRecommendation
  differencePercent: number; // difference / originalRecommendation * 100
  projectType: string;
  itemDescription: string;
  specification?: string;
  material?: string;
  reason?: string;
}

export interface AuditLogItem {
  id: string;
  timestamp: string;
  user: string;
  // "Historical Replay" is retired for new events (kept in the union so persisted legacy
  // log entries still type-check); new RFQ uploads log as "RFQ Upload".
  action: "Historical Ingestion" | "RFQ Upload" | "Deletion" | "Knowledge Base Merge" | "Rate Recommendation" | "Historical Replay" | "Export" | "Validation" | "Settings Update" | "System Administration" | "Error Log";
  details: string;
  status: "Success" | "Failure";
}

export interface SystemHealth {
  kbSizeMb: number;
  cacheStatus: string;
  parserPerformanceMs: number;
  recommendationPerformanceMs: number;
  exportPerformanceMs: number;
  databaseStatus: string;
  regressionStatus: string;
  memoryUsageMb: number;
  kbVersion?: string;
  historicalProjectsCount: number;
  masterBOQCount: number;
  basicRatesCount: number;
  historicalRatesCount: number;
  embeddingRecordsCount: number;
  pendingRecommendationsCount: number;
  completedRecommendationsCount: number;
  /**
   * % of rated items Auto Approved by the Commercial Decision Engine - the platform's
   * one accuracy figure (ADR-0001), shared with /api/analytics and per-RFQ audit reports.
   */
  approvalAccuracy: number;
  regressionSuite?: {
    passed: boolean;
    total: number;
    tests: {
      name: string;
      status: "Passed" | "Failed";
      durationMs: number;
      details: string;
    }[];
  };
}

export interface WorkbookBlueprint {
  id: string;
  fileName: string;
  isProtected?: boolean;
  sheets: Record<string, {
    sheetName: string;
    visibility: string;
    isProtected: boolean;
    freezePanes?: any;
    columnWidths: Record<number, number>;
    rowHeights: Record<number, number>;
    hiddenRows: number[];
    hiddenColumns: number[];
    mergedCells: string[];
    formulaCells: Record<string, { formula: string; result?: any }>;
    protectedCells: string[];
    rateCellColumn: number;
    amountCellColumn: number;
    writableRateCells: Record<number, { cellAddress: string; rfqItemId: string }>;

    // A "Remarks"/"Notes"/"Comments" column, if this sheet has one - never referenced by a
    // numeric Rate/Amount formula, so it's a safe place to write a human-readable Manual
    // Pricing flag on export without risking #VALUE! errors in downstream SUM/rollup formulas.
    remarksColumn?: number;

    // Set only when the sheet has a genuinely separate Installation Rate column (distinct from
    // the Supply/Unit Rate column above) - undefined/-1 means this sheet has just one Rate
    // column, and installation recommendation logic must be ignored entirely for it.
    installationRateCellColumn?: number;
    writableInstallationRateCells?: Record<number, { cellAddress: string; rfqItemId: string }>;
    supplyColumnConfidence?: "high" | "low";
    installationColumnConfidence?: "high" | "none";
    supplyHeaderText?: string;
    installationHeaderText?: string;

    // Single source of truth for this sheet's Supply/Installation column layout, built once
    // during header detection and never re-derived - every downstream consumer (recommend,
    // export, validation, diagnostics) reads from this instead of re-scanning headers.
    ratePair?: {
      supplyRateColumn: number;
      installationRateColumn?: number;
      supplyAmountColumn?: number;
      installationAmountColumn?: number;
      totalColumn?: number;
    };

    // BOQ Deep Understanding Enhancements
    detectedType?: "Cover page" | "Index" | "General Notes" | "Preambles" | "Legends" | "Specifications" | "Measurement Rules" | "BOQ Sheets" | "Abstract" | "Summary" | string;
    confidenceScore?: number;
    extractedKeywords?: string[];
    classificationReason?: string;
    metadata?: Record<string, string>;
    summary?: string;
  }>;
  projectMetadata?: {
    projectName?: string;
    clientName?: string;
    consultantName?: string;
    location?: string;
    date?: string;
    tenderId?: string;
    totalValue?: number;
    version?: string;
    [key: string]: any;
  };
  allExtractedKnowledge?: {
    sheetClassifications: { sheetName: string; detectedType: string; confidenceScore: number; reason: string }[];
    projectMetadata: any;
    generalNotesSummary?: string;
    preambleSummary?: string;
    specificationsSummary?: string;
    totalSheets: number;
    boqSheetsCount: number;
    [key: string]: any;
  };
}

export interface ValidationDifference {
  sheetName: string;
  cellAddress?: string;
  type: "structure" | "meta" | "style" | "formula" | "other";
  expected: string;
  actual: string;
  reason: string;
}

export interface ValidationReport {
  success: boolean;
  timestamp: string;
  differences: ValidationDifference[];
}


