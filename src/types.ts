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
  status: "Draft" | "Analyzing" | "Rated" | "Replay";
  preamblePasted?: string;
  preambleExtracted?: PreambleData;
  
  // Historical Replay features
  replayDetected?: boolean;
  matchedProjectName?: string;
  workbookMatchPercent?: number;
  worksheetMatchPercent?: number;
  itemMatchPercent?: number;

  // Enterprise Context
  projectContext?: ProjectContext;
  worksheetContexts?: Record<string, WorksheetContext>;
  kbVersion?: string;
  workbookBlueprint?: WorkbookBlueprint;

  // Profiling performance fields
  parseTimeMs?: number;
  retrievalTimeMs?: number;
  recommendationTimeMs?: number;

  // Historical Replay Verification fields
  verifiedReplayRows?: {
    projectId: string;
    worksheetId: string;
    rowNumber: number;
    rateCellAddress: string;
    amountCellAddress: string;
    originalHistoricalRate: number;
  }[];
  verificationMismatches?: {
    worksheet: string;
    row: number;
    originalRate: number;
    injectedRate: number;
    reason: string;
  }[];
  replayAuditorReport?: {
    replayAccuracy: number;
    verifiedRows: number;
    failedRows: number;
    missingRows: number;
    extraRows: number;
    pendingRows: number;
    records: {
      projectId: string;
      worksheetName: string;
      rowNumber: number;
      originalDescription: string;
      masterItemId: string;
      originalHistoricalRate: number;
      injectedRate: number;
      unitRateCellAddress: string;
      amountCellAddress: string;
      status: "VERIFIED" | "FAILED";
      difference?: number;
    }[];
  };
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
  confidenceScore: number; // percentage, e.g. 85
  reason: string;
  parentHierarchy: string[]; // e.g. ["Civil Works", "Flooring", "Granite Flooring"]
  status: "Pending" | "Accepted" | "Needs Manual Review";
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
  uomTrace?: string[];
  rateStats?: {
    min: number;
    max: number;
    mean: number;
    median: number;
    weightedMedian: number;
    commercialRate: number;
    conservative: number;
    balanced: number;
    premium: number;
    mostProbable: number;
    finalRecommended: number;
    calculationsLog: string;
  };
  validationResults?: {
    engineering: boolean;
    specification: boolean;
    commercial: boolean;
    uom: boolean;
    historical: boolean;
    workbook: boolean;
    regression: boolean;
    details: string[];
  };
  manualReviewRequired?: boolean;
  recommendationTrace?: {
    rfqItem: string;
    historicalProject: string;
    historicalProjectID?: string;
    historicalRow?: number;
    historicalWorksheet: string;
    historicalCell: string;
    historicalUnitRate: number;
    recommendedUnitRate: number;
    replayMode: "Yes" | "No";
    matchType?: string;
    explanation?: string;
    historicalProjectCost?: number;
    historicalProjectType?: string;
    rateSource?: string;
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

export interface AuditLogItem {
  id: string;
  timestamp: string;
  user: string;
  action: "Historical Ingestion" | "Deletion" | "Knowledge Base Merge" | "Rate Recommendation" | "Historical Replay" | "Export" | "Validation" | "Settings Update" | "System Administration" | "Error Log";
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
  replayAccuracy: number;
  recommendationAccuracy: number;
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

