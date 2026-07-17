/**
 * KnowledgeBaseEngine (implemented)
 *
 * Single source of truth for the Master BOQ catalog. Owns: parsing historical BOQ
 * sheets, extracting per-item engineering attributes, clustering rows into canonical
 * Master Items while preserving every historical occurrence, generating searchable
 * metadata (keywords/synonyms/normalized text/stemmed tokens - no embeddings), building
 * attribute-scoped indexes for later consumption by RecommendationEngineV2, and storing
 * rich per-project metadata.
 *
 * Scope boundary (deliberate, unchanged from the prior pass): this engine does not
 * match RFQ items, does not score project similarity, does not aggregate dashboard
 * metrics, and does not compute confidence. It has no dependency on any other file
 * under /engines and is not imported by any of them.
 *
 * Persistence is a dedicated JSON file under backend/data/ - it never reads or writes
 * any of the legacy root-level *_store.json files.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { EngineeringDimensions } from "./EngineeringParser.js";

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

export interface HistoricalItemOccurrenceInput {
  rate: number;
  unit: string;
  projectId: string;
  projectName: string;
  companyName?: string;
  worksheetName?: string;
  rowNumber?: number;
  cellAddress?: string;
  quantity?: number;
  amount?: number;
  recordedAt: string;
}

export interface HistoricalItemOccurrence extends HistoricalItemOccurrenceInput {
  masterItemId: string;
  originalDescription: string;
}

export interface MasterCatalogItem {
  id: string; // Master Item ID
  canonicalDescription: string;
  domain: string;
  category?: string;
  subcategory?: string;
  material?: string;
  materialType?: string;
  specification?: string;
  brand?: string;
  grade?: string;
  finish?: string;
  thickness?: number;
  dimensions: EngineeringDimensions;
  capacity?: number;
  voltage?: number;
  pipeDiameter?: number;
  executionMethod?: string;
  uom: string;
  keywords: string[];
  synonyms: string[];
  normalizedDescription: string;
  stemmedTokens: string[];
  searchTokens: string[];
  historicalOccurrences: HistoricalItemOccurrence[];
  basicRateOccurrences: HistoricalItemOccurrence[];
  historicalProjects: string[];
  projectTypes: string[];
  cities: string[];
  averageRate: number;
  medianRate: number;
  minRate: number;
  maxRate: number;
  basicRate?: number;
  occurrenceCount: number;
  lastUpdated: string;
}

export interface MasterCatalogQuery {
  description: string;
  domain: string;
  unit?: string;
}

export interface MasterCatalogMatch {
  item: MasterCatalogItem;
  matchScore: number;
  matchType: "exact" | "fuzzy";
}

export interface MasterCatalogUpsertRequest {
  description: string;
  domain: string;
  unit: string;
  rateSample: HistoricalItemOccurrenceInput;
  dimensions?: EngineeringDimensions;
  isBasicRate?: boolean;
  projectType?: string;
  city?: string;
}

export interface ProjectMetadataRecord {
  projectId: string;
  projectName: string;
  client?: string;
  company?: string;
  fileName: string;
  uploadDate: string;
  projectCost?: number;
  projectCostRaw?: string;
  projectSize?: number;
  projectSizeRaw?: string;
  projectType?: string;
  city?: string;
  buildingGrade?: string;
  completionYear?: string;
  domains: string[];
  itemCount: number;
}

export interface ExtractedEngineeringAttributes {
  category?: string;
  material?: string;
  materialType?: string;
  specification?: string;
  executionMethod?: string;
  dimensions: EngineeringDimensions;
}

export interface HistoricalBOQSheetInput {
  sheetName: string;
  rows: unknown[][];
}

export interface HistoricalBOQIngestInput {
  projectId?: string;
  projectName: string;
  contractorName?: string;
  fileName: string;
  sheets: HistoricalBOQSheetInput[];
  client?: string;
  company?: string;
  projectCost?: number;
  projectSize?: number;
  projectType?: string;
  city?: string;
  buildingGrade?: string;
  completionYear?: string;
}

export interface HistoricalBOQIngestValidation {
  projectsParsed: number;
  masterItemsCreated: number;
  historicalRatesStored: number;
  basicRatesStored: number;
  keywordsExtracted: number;
  duplicateItemsMerged: number;
  itemsMissingAttributes: number;
}

export interface HistoricalBOQIngestResult {
  projectId: string;
  validation: HistoricalBOQIngestValidation;
  domainsDetected: string[];
  skippedSheets: string[];
  projectMetadata: ProjectMetadataRecord;
}

export interface KnowledgeBaseEngineOptions {
  storageFilePath?: string;
  similarityThreshold?: number;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface IKnowledgeBaseEngine {
  ingestHistoricalBOQ(input: HistoricalBOQIngestInput): Promise<HistoricalBOQIngestResult>;

  findBestMatch(query: MasterCatalogQuery): Promise<MasterCatalogMatch | null>;
  upsertFromHistoricalRow(request: MasterCatalogUpsertRequest): Promise<MasterCatalogItem>;
  mergeItems(sourceId: string, targetId: string): Promise<MasterCatalogItem>;
  getById(id: string): Promise<MasterCatalogItem | null>;
  recomputeStatistics(item: MasterCatalogItem): MasterCatalogItem;
  list(domain?: string): Promise<MasterCatalogItem[]>;
  delete(id: string): Promise<void>;

  search(keyword: string, domain?: string): Promise<MasterCatalogItem[]>;

  // Step 5 - attribute-scoped indexes, for later consumption by RecommendationEngineV2.
  findByMaterial(material: string): Promise<MasterCatalogItem[]>;
  findBySpecification(specification: string): Promise<MasterCatalogItem[]>;
  findByBrand(brand: string): Promise<MasterCatalogItem[]>;
  findByGrade(grade: string): Promise<MasterCatalogItem[]>;
  findByThickness(thicknessMm: number): Promise<MasterCatalogItem[]>;
  findByDimensions(widthMm: number, heightMm: number): Promise<MasterCatalogItem[]>;
  findByUOM(uom: string): Promise<MasterCatalogItem[]>;
  findByDomain(domain: string): Promise<MasterCatalogItem[]>;
  findByCategory(category: string): Promise<MasterCatalogItem[]>;
  findByProjectType(projectType: string): Promise<MasterCatalogItem[]>;
  findByCity(city: string): Promise<MasterCatalogItem[]>;

  getProjectMetadata(projectId: string): Promise<ProjectMetadataRecord | null>;
  listProjectMetadata(): Promise<ProjectMetadataRecord[]>;

  extractEngineeringAttributes(description: string): ExtractedEngineeringAttributes;
  extractKeywords(description: string): string[];
  expandSynonyms(tokens: string[]): string[];
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const DEFAULT_STORAGE_PATH = path.join(process.cwd(), "backend", "data", "knowledge-base-store.json");

const SKIP_SHEET_KEYWORDS = [
  "cover", "index", "summary", "abstract", "drawing", "tax", "note", "preamble",
  "instruction", "tender", "payment", "term", "condition", "guarantee",
  "compliance", "commercial", "legal", "clause", "sign"
];

const BASIC_RATE_SHEET_KEYWORDS = [
  "basic rate", "basic price", "material rate", "rate schedule", "price list", "material basic"
];

const DOMAIN_KEYWORDS: Array<{ domain: string; pattern: RegExp }> = [
  { domain: "Civil", pattern: /\bcivil\b/i },
  { domain: "Interior", pattern: /\b(interior|fit\s*-?out|furniture|joinery)\b/i },
  { domain: "Electrical", pattern: /\b(electrical|elec|power|lighting)\b/i },
  { domain: "Mechanical", pattern: /\b(mechanical|hvac|plumbing|phe|fire\s*fighting)\b/i }
];

const ACTIVITY_KEYWORDS: Record<string, RegExp> = {
  Supply: /\bsupply\b/i,
  Installation: /\b(install|installation|fixing|laying)\b/i,
  Excavation: /\bexcavat/i,
  Concreting: /\bconcret/i,
  Painting: /\bpaint/i,
  Plastering: /\bplaster/i,
  Flooring: /\bfloor/i,
  Wiring: /\b(wiring|cabling)\b/i,
  Plumbing: /\bplumb/i
};

const MATERIAL_KEYWORDS: Record<string, RegExp> = {
  Plywood: /\bply(wood)?\b/i,
  Laminate: /\blaminate\b/i,
  Granite: /\bgranite\b/i,
  Marble: /\bmarble\b/i,
  "Vitrified Tile": /\bvitrified\b/i,
  "Gypsum Board": /\bgypsum\b/i,
  "Mild Steel": /\b(mild steel|\bms\b)/i,
  "Stainless Steel": /\b(stainless steel|\bss\b)/i,
  Aluminium: /\b(aluminium|aluminum)\b/i,
  Glass: /\bglass\b/i,
  Concrete: /\b(concrete|rcc|pcc)\b/i,
  Copper: /\bcopper\b/i,
  PVC: /\bpvc\b/i
};

const MATERIAL_TYPE_MAP: Record<string, string> = {
  Plywood: "Wood",
  Laminate: "Wood Finish",
  Granite: "Stone",
  Marble: "Stone",
  "Vitrified Tile": "Tile",
  "Gypsum Board": "Board",
  "Mild Steel": "Metal",
  "Stainless Steel": "Metal",
  Aluminium: "Metal",
  Glass: "Glass",
  Concrete: "Concrete",
  Copper: "Metal",
  PVC: "Plastic"
};

const KNOWN_BRANDS = [
  "Asian Paints", "Hettich", "Kohler", "Jaguar", "Grohe", "Hafele",
  "Godrej", "Havells", "Legrand", "Schneider", "Saint-Gobain"
];

const STOPWORDS = new Set([
  "the", "and", "of", "for", "with", "to", "in", "on", "a", "an", "as",
  "at", "by", "from", "or", "is", "are", "this", "that"
]);

const SYNONYM_GROUPS: string[][] = [
  ["ms", "mild", "steel"],
  ["ss", "stainless", "steel"],
  ["rcc", "reinforced", "cement", "concrete"],
  ["pcc", "plain", "cement", "concrete"],
  ["gi", "galvanized", "iron"],
  ["ply", "plywood"],
  ["lam", "laminate"],
  ["sqm", "square", "metre", "meter"],
  ["sqft", "sft", "square", "feet", "foot"],
  ["cum", "cubic", "metre", "meter"],
  ["cft", "cubic", "feet", "foot"],
  ["rmt", "running", "metre", "meter"],
  ["nos", "no", "number", "numbers"],
  ["elec", "electrical"],
  ["mech", "mechanical"]
];

const CITY_KEYWORDS = [
  "Gurugram", "Gurgaon", "Noida", "New Delhi", "Delhi", "NCR", "Mumbai", "Pune",
  "Bangalore", "Bengaluru", "Hyderabad", "Chennai", "Kolkata", "Jaipur", "Ahmedabad", "Chandigarh"
];

const PROJECT_TYPE_KEYWORDS: Array<{ type: string; pattern: RegExp }> = [
  { type: "Commercial Office", pattern: /\b(commercial|office|corporate)\b/i },
  { type: "Residential", pattern: /\b(residential|apartment|villa|housing)\b/i },
  { type: "Retail", pattern: /\b(retail|mall|showroom|store)\b/i },
  { type: "Hospitality", pattern: /\b(hotel|hospitality|resort)\b/i },
  { type: "Healthcare", pattern: /\b(hospital|healthcare|clinic)\b/i },
  { type: "Industrial", pattern: /\b(industrial|warehouse|factory|plant)\b/i },
  { type: "Educational", pattern: /\b(school|educational|campus|university)\b/i }
];

const STEM_SUFFIXES = ["ing", "edly", "ed", "ies", "es", "ly", "s"];

interface DetectedColumns {
  headerRowIndex: number;
  descriptionCol: number;
  unitCol: number;
  quantityCol: number;
  rateCol: number;
  amountCol: number;
}

interface ParsedBOQRow {
  description: string;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
  rowNumber: number;
  cellAddress: string;
}

interface ParsedBasicRateRow {
  description: string;
  unit: string;
  rate: number;
  rowNumber: number;
  cellAddress: string;
}

interface UpsertOutcome {
  item: MasterCatalogItem;
  isNewItem: boolean;
  hasAttributes: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class KnowledgeBaseEngine implements IKnowledgeBaseEngine {
  private readonly catalog = new Map<string, MasterCatalogItem>();
  private readonly projectMetadata = new Map<string, ProjectMetadataRecord>();

  private readonly invertedIndex = new Map<string, Set<string>>();
  private readonly materialIndex = new Map<string, Set<string>>();
  private readonly specificationIndex = new Map<string, Set<string>>();
  private readonly brandIndex = new Map<string, Set<string>>();
  private readonly gradeIndex = new Map<string, Set<string>>();
  private readonly thicknessIndex = new Map<string, Set<string>>();
  private readonly dimensionsIndex = new Map<string, Set<string>>();
  private readonly uomIndex = new Map<string, Set<string>>();
  private readonly domainIndex = new Map<string, Set<string>>();
  private readonly categoryIndex = new Map<string, Set<string>>();
  private readonly projectTypeIndex = new Map<string, Set<string>>();
  private readonly cityIndex = new Map<string, Set<string>>();

  private readonly synonymDictionary: Map<string, Set<string>>;
  private readonly storageFilePath: string;
  private readonly similarityThreshold: number;

  constructor(options: KnowledgeBaseEngineOptions = {}) {
    this.storageFilePath = options.storageFilePath ?? DEFAULT_STORAGE_PATH;
    this.similarityThreshold = options.similarityThreshold ?? 0.6;
    this.synonymDictionary = this.buildSynonymDictionary();
    this.loadFromDisk();
  }

  // =========================================================================
  // STEP 1 - Project metadata extraction
  // =========================================================================

  private resolveProjectMetadata(input: HistoricalBOQIngestInput): Partial<ProjectMetadataRecord> {
    const scanned = this.scanSheetsForMetadataLabels(input.sheets ?? []);
    const fallbackText = `${input.projectName} ${input.fileName}`;
    const inferred = this.inferProjectMetadataFromText(fallbackText);

    return {
      client: input.client ?? scanned.client ?? inferred.client,
      company: input.company ?? input.contractorName ?? scanned.company,
      projectCost: input.projectCost ?? scanned.projectCost ?? inferred.projectCost,
      projectCostRaw: scanned.projectCostRaw ?? inferred.projectCostRaw,
      projectSize: input.projectSize ?? scanned.projectSize ?? inferred.projectSize,
      projectSizeRaw: scanned.projectSizeRaw ?? inferred.projectSizeRaw,
      projectType: input.projectType ?? scanned.projectType ?? inferred.projectType,
      city: input.city ?? scanned.city ?? inferred.city,
      buildingGrade: input.buildingGrade ?? scanned.buildingGrade ?? inferred.buildingGrade,
      completionYear: input.completionYear ?? scanned.completionYear ?? inferred.completionYear
    };
  }

  private scanSheetsForMetadataLabels(sheets: HistoricalBOQSheetInput[]): Partial<ProjectMetadataRecord> {
    const found: Partial<ProjectMetadataRecord> = {};
    const bag = found as Record<string, unknown>;

    const assignIfEmpty = (field: string, value: string | number | undefined) => {
      if (value !== undefined && value !== "" && bag[field] === undefined) {
        bag[field] = value;
      }
    };

    const applyLabel = (label: string, value: string) => {
      if (!value) return;
      if (/^client$/i.test(label)) assignIfEmpty("client", value);
      else if (/^(contractor|company|vendor)$/i.test(label)) assignIfEmpty("company", value);
      else if (/^(city|location)$/i.test(label)) assignIfEmpty("city", value);
      else if (/^project\s*type$/i.test(label)) assignIfEmpty("projectType", value);
      else if (/^(building\s*)?grade$/i.test(label)) assignIfEmpty("buildingGrade", value);
      else if (/^(completion\s*)?year$/i.test(label)) assignIfEmpty("completionYear", value);
      else if (/^(project\s*|total\s*)?cost$/i.test(label)) {
        assignIfEmpty("projectCostRaw", value);
        const parsed = this.parseCurrencyToNumber(value);
        if (parsed !== null) assignIfEmpty("projectCost", parsed);
      } else if (/^(project\s*size|built[\s-]*up\s*area)$/i.test(label)) {
        assignIfEmpty("projectSizeRaw", value);
        const parsed = this.parseAreaToNumber(value);
        if (parsed !== null) assignIfEmpty("projectSize", parsed);
      }
    };

    for (const sheet of sheets) {
      const scanLimit = Math.min(sheet.rows?.length ?? 0, 20);
      for (let r = 0; r < scanLimit; r++) {
        const row = sheet.rows[r] ?? [];
        for (let c = 0; c < row.length; c++) {
          const cellText = String(row[c] ?? "").trim();
          if (!cellText) continue;

          const inlineMatch = cellText.match(/^([a-zA-Z\s]{2,30})\s*[:\-]\s*(.+)$/);
          if (inlineMatch) {
            applyLabel(inlineMatch[1].trim(), inlineMatch[2].trim());
            continue;
          }

          const nextCell = row[c + 1];
          if (nextCell !== undefined && String(nextCell).trim()) {
            applyLabel(cellText, String(nextCell).trim());
          }
        }
      }
    }

    return found;
  }

  private inferProjectMetadataFromText(text: string): Partial<ProjectMetadataRecord> {
    const result: Partial<ProjectMetadataRecord> = {};

    const cityHit = CITY_KEYWORDS.find((city) => text.toLowerCase().includes(city.toLowerCase()));
    if (cityHit) result.city = cityHit;

    if (/grade\s*a|premium|luxury/i.test(text)) result.buildingGrade = "Grade A";
    else if (/grade\s*b|standard/i.test(text)) result.buildingGrade = "Grade B";

    const typeHit = PROJECT_TYPE_KEYWORDS.find(({ pattern }) => pattern.test(text));
    if (typeHit) result.projectType = typeHit.type;

    const yearMatch = text.match(/\b(20\d{2})\b/);
    if (yearMatch) result.completionYear = yearMatch[1];

    const costMatch = text.match(/(?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d+)?/i);
    if (costMatch) {
      result.projectCostRaw = costMatch[0];
      const parsed = this.parseCurrencyToNumber(costMatch[0]);
      if (parsed !== null) result.projectCost = parsed;
    }

    const sizeMatch = text.match(/[\d,]+(?:\.\d+)?\s*(?:sq\.?\s*ft|sqft|sft)/i);
    if (sizeMatch) {
      result.projectSizeRaw = sizeMatch[0];
      const parsed = this.parseAreaToNumber(sizeMatch[0]);
      if (parsed !== null) result.projectSize = parsed;
    }

    return result;
  }

  private parseCurrencyToNumber(text: string): number | null {
    const match = text.match(/([\d,]+(?:\.\d+)?)/);
    if (!match) return null;
    const value = parseFloat(match[1].replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
  }

  private parseAreaToNumber(text: string): number | null {
    return this.parseCurrencyToNumber(text);
  }

  async getProjectMetadata(projectId: string): Promise<ProjectMetadataRecord | null> {
    return this.projectMetadata.get(projectId) ?? null;
  }

  async listProjectMetadata(): Promise<ProjectMetadataRecord[]> {
    return Array.from(this.projectMetadata.values());
  }

  // =========================================================================
  // Parsing (sheet classification, column detection, row extraction)
  // =========================================================================

  async ingestHistoricalBOQ(input: HistoricalBOQIngestInput): Promise<HistoricalBOQIngestResult> {
    const projectId = input.projectId ?? this.generateId("proj");
    const resolvedMetadata = this.resolveProjectMetadata(input);

    const domainsDetected = new Set<string>();
    const skippedSheets: string[] = [];
    const keywordsSeenThisIngest = new Set<string>();

    let masterItemsCreated = 0;
    let duplicateItemsMerged = 0;
    let historicalRatesStored = 0;
    let basicRatesStored = 0;
    let itemsMissingAttributes = 0;

    const recordOutcome = (outcome: UpsertOutcome, description: string) => {
      if (outcome.isNewItem) masterItemsCreated++;
      else duplicateItemsMerged++;
      if (!outcome.hasAttributes) itemsMissingAttributes++;
      this.extractKeywords(description).forEach((keyword) => keywordsSeenThisIngest.add(keyword));
    };

    for (const sheet of input.sheets ?? []) {
      if (this.isBasicRateSheet(sheet.sheetName)) {
        const domain = this.detectDomain(sheet.sheetName);
        domainsDetected.add(domain);
        const columns = this.detectColumns(sheet.rows);
        const basicRows = this.parseBasicRateSheetRows(sheet.rows, columns);

        for (const row of basicRows) {
          const outcome = this.upsertInternal({
            description: row.description,
            domain,
            unit: row.unit,
            isBasicRate: true,
            projectType: resolvedMetadata.projectType,
            city: resolvedMetadata.city,
            rateSample: {
              rate: row.rate,
              unit: row.unit,
              projectId,
              projectName: input.projectName,
              companyName: resolvedMetadata.company,
              worksheetName: sheet.sheetName,
              rowNumber: row.rowNumber,
              cellAddress: row.cellAddress,
              recordedAt: new Date().toISOString()
            }
          });
          basicRatesStored++;
          recordOutcome(outcome, row.description);
        }
        continue;
      }

      if (this.shouldSkipSheet(sheet.sheetName)) {
        skippedSheets.push(sheet.sheetName);
        continue;
      }

      const domain = this.detectDomain(sheet.sheetName);
      domainsDetected.add(domain);
      const columns = this.detectColumns(sheet.rows);
      const boqRows = this.parseBOQSheetRows(sheet.rows, columns);

      for (const row of boqRows) {
        const outcome = this.upsertInternal({
          description: row.description,
          domain,
          unit: row.unit,
          isBasicRate: false,
          projectType: resolvedMetadata.projectType,
          city: resolvedMetadata.city,
          rateSample: {
            rate: row.rate,
            unit: row.unit,
            projectId,
            projectName: input.projectName,
            companyName: resolvedMetadata.company,
            worksheetName: sheet.sheetName,
            rowNumber: row.rowNumber,
            cellAddress: row.cellAddress,
            quantity: row.quantity,
            amount: row.amount,
            recordedAt: new Date().toISOString()
          }
        });
        historicalRatesStored++;
        recordOutcome(outcome, row.description);
      }
    }

    const projectMetadata: ProjectMetadataRecord = {
      projectId,
      projectName: input.projectName,
      fileName: input.fileName,
      uploadDate: new Date().toISOString(),
      domains: Array.from(domainsDetected),
      itemCount: historicalRatesStored + basicRatesStored,
      ...resolvedMetadata
    };

    this.projectMetadata.set(projectId, projectMetadata);
    this.persistToDisk();

    return {
      projectId,
      validation: {
        projectsParsed: 1,
        masterItemsCreated,
        historicalRatesStored,
        basicRatesStored,
        keywordsExtracted: keywordsSeenThisIngest.size,
        duplicateItemsMerged,
        itemsMissingAttributes
      },
      domainsDetected: Array.from(domainsDetected),
      skippedSheets,
      projectMetadata
    };
  }

  private shouldSkipSheet(sheetName: string): boolean {
    const name = sheetName.toLowerCase();
    return SKIP_SHEET_KEYWORDS.some((keyword) => name.includes(keyword));
  }

  private isBasicRateSheet(sheetName: string): boolean {
    const name = sheetName.toLowerCase();
    return BASIC_RATE_SHEET_KEYWORDS.some((keyword) => name.includes(keyword));
  }

  private detectDomain(sheetName: string): string {
    for (const { domain, pattern } of DOMAIN_KEYWORDS) {
      if (pattern.test(sheetName)) return domain;
    }
    const cleaned = sheetName.replace(/[^a-zA-Z0-9\s]/g, " ").trim();
    if (!cleaned) return "General";
    return cleaned
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  }

  private detectColumns(rows: unknown[][]): DetectedColumns {
    const scanLimit = Math.min(rows?.length ?? 0, 12);
    for (let r = 0; r < scanLimit; r++) {
      const row = rows[r] ?? [];
      let descriptionCol = -1;
      let unitCol = -1;
      let quantityCol = -1;
      let rateCol = -1;
      let amountCol = -1;

      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] ?? "").trim().toLowerCase();
        if (!cell) continue;
        if (descriptionCol === -1 && /(description|particular|item\s*name|material)/.test(cell)) descriptionCol = c;
        if (unitCol === -1 && /(^unit$|uom)/.test(cell)) unitCol = c;
        if (quantityCol === -1 && /(qty|quantity)/.test(cell)) quantityCol = c;
        if (rateCol === -1 && /(rate|price)/.test(cell)) rateCol = c;
        if (amountCol === -1 && /(amount|total)/.test(cell)) amountCol = c;
      }

      if (descriptionCol !== -1 && rateCol !== -1) {
        return { headerRowIndex: r, descriptionCol, unitCol, quantityCol, rateCol, amountCol };
      }
    }

    // Positional fallback when no header row is confidently detected.
    return { headerRowIndex: -1, descriptionCol: 0, unitCol: 1, quantityCol: 2, rateCol: 3, amountCol: -1 };
  }

  private parseNumericCell(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const parsed = typeof value === "number" ? value : parseFloat(String(value).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private inferUnitFromText(text: string): string | null {
    const match = text.match(/\/\s*(sft|sqm|sqft|rmt|cum|cft|kg|nos?|ltr|each)\b/i);
    return match ? match[1] : null;
  }

  private toExcelCellAddress(rowNumber: number, zeroBasedCol: number): string {
    if (zeroBasedCol < 0) return `R${rowNumber}`;
    let col = zeroBasedCol + 1;
    let colLetters = "";
    while (col > 0) {
      const rem = (col - 1) % 26;
      colLetters = String.fromCharCode(65 + rem) + colLetters;
      col = Math.floor((col - 1) / 26);
    }
    return `${colLetters}${rowNumber}`;
  }

  private parseBOQSheetRows(rows: unknown[][], columns: DetectedColumns): ParsedBOQRow[] {
    const startRow = columns.headerRowIndex + 1;
    const results: ParsedBOQRow[] = [];

    for (let r = startRow; r < (rows?.length ?? 0); r++) {
      const row = rows[r] ?? [];
      const description = String(row[columns.descriptionCol] ?? "").trim();
      const unit = String(row[columns.unitCol] ?? "").trim() || "Unit";
      const quantity = this.parseNumericCell(row[columns.quantityCol]);
      const rate = this.parseNumericCell(row[columns.rateCol]);

      if (!description || quantity === null || rate === null || quantity <= 0 || rate <= 0) continue;

      const amountCell = columns.amountCol !== -1 ? this.parseNumericCell(row[columns.amountCol]) : null;
      const rowNumber = r + 1;

      results.push({
        description,
        unit,
        quantity,
        rate,
        amount: amountCell ?? quantity * rate,
        rowNumber,
        cellAddress: this.toExcelCellAddress(rowNumber, columns.rateCol)
      });
    }

    return results;
  }

  private parseBasicRateSheetRows(rows: unknown[][], columns: DetectedColumns): ParsedBasicRateRow[] {
    const startRow = columns.headerRowIndex + 1;
    const results: ParsedBasicRateRow[] = [];

    for (let r = startRow; r < (rows?.length ?? 0); r++) {
      const row = rows[r] ?? [];
      const description = String(row[columns.descriptionCol] ?? "").trim();
      if (!description) continue;

      let rateCol = columns.rateCol;
      let rate = this.parseNumericCell(row[columns.rateCol]);
      if (rate === null) {
        // Basic-rate sheets are frequently laid out irregularly (label + value on the
        // same row with no fixed column) - fall back to the first positive numeric cell.
        for (let c = 0; c < row.length; c++) {
          const parsed = this.parseNumericCell(row[c]);
          if (parsed !== null && parsed > 0) {
            rate = parsed;
            rateCol = c;
            break;
          }
        }
      }
      if (rate === null || rate <= 0) continue;

      const unit = String(row[columns.unitCol] ?? "").trim() || this.inferUnitFromText(description) || "Unit";
      const rowNumber = r + 1;

      results.push({
        description,
        unit,
        rate,
        rowNumber,
        cellAddress: this.toExcelCellAddress(rowNumber, rateCol)
      });
    }

    return results;
  }

  // =========================================================================
  // STEP 2 - Engineering attribute extraction
  // =========================================================================

  extractEngineeringAttributes(description: string): ExtractedEngineeringAttributes {
    const text = description ?? "";
    const dimensions = this.extractDimensionsInternal(text);
    const category = this.extractFirstMatch(text, ACTIVITY_KEYWORDS);
    const material = this.extractFirstMatch(text, MATERIAL_KEYWORDS);
    const materialType = material ? MATERIAL_TYPE_MAP[material] : undefined;
    const hasSpec = Boolean(
      dimensions.grade || dimensions.mixRatio || dimensions.thickness !== undefined || dimensions.diameter !== undefined
    );
    const executionMethod = this.deriveExecutionMethod(text);

    return {
      category,
      material,
      materialType,
      specification: hasSpec ? text.trim() : undefined,
      executionMethod,
      dimensions
    };
  }

  private deriveExecutionMethod(text: string): string | undefined {
    const hasSupply = /\bsupply\b/i.test(text);
    const hasInstall = /\b(install|installation|fixing|laying)\b/i.test(text);
    if (hasSupply && hasInstall) return "Supply & Installation";
    if (hasSupply) return "Supply Only";
    if (hasInstall) return "Installation Only";
    return undefined;
  }

  private deriveSubcategory(category: string | undefined, material: string | undefined): string | undefined {
    if (category && material) return `${material} ${category}`;
    return material ?? category;
  }

  private extractFirstMatch(text: string, dictionary: Record<string, RegExp>): string | undefined {
    for (const [label, pattern] of Object.entries(dictionary)) {
      if (pattern.test(text)) return label;
    }
    return undefined;
  }

  private extractDimensionsInternal(text: string): EngineeringDimensions {
    const dimensions: EngineeringDimensions = {};

    const thicknessMatch =
      text.match(/(\d+(?:\.\d+)?)\s*mm\s*(?:thk\.?|thick)/i) ||
      text.match(/(?:thk\.?|thickness)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*mm/i);
    if (thicknessMatch) dimensions.thickness = parseFloat(thicknessMatch[1]);

    const isPipeContext = /\bpipe\b/i.test(text);
    const diameterMatch =
      text.match(/(?:dia\.?|diameter)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*mm/i) ||
      text.match(/(\d+(?:\.\d+)?)\s*mm\s*dia\.?/i) ||
      text.match(/\bDN\s?(\d+(?:\.\d+)?)\b/i);
    if (diameterMatch) {
      const value = parseFloat(diameterMatch[1]);
      if (isPipeContext) dimensions.pipeDiameter = value;
      else dimensions.diameter = value;
    }

    const capacityMatch = text.match(/(\d+(?:\.\d+)?)\s*(w|watt|watts|ton|tr|kva|hp)\b/i);
    if (capacityMatch) dimensions.capacity = parseFloat(capacityMatch[1]);

    const voltageMatch = text.match(/(\d+(?:\.\d+)?)\s*(kv|kilovolt|v|volt|volts)\b/i);
    if (voltageMatch) {
      const raw = parseFloat(voltageMatch[1]);
      dimensions.voltage = /kv|kilovolt/i.test(voltageMatch[2]) ? raw * 1000 : raw;
    }

    const gradeMatch = text.match(/\b(M\s?\d{2}|Fe\s?\d{3})\b/i);
    if (gradeMatch) dimensions.grade = gradeMatch[1].toUpperCase().replace(/\s+/g, "");

    const mixMatch = text.match(/\b(1\s*:\s*\d+(?:\s*:\s*\d+)?)\b/);
    if (mixMatch) dimensions.mixRatio = mixMatch[1].replace(/\s+/g, "");

    const widthHeightMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:mm|cm)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:mm|cm)?/i);
    if (widthHeightMatch) {
      dimensions.width = parseFloat(widthHeightMatch[1]);
      dimensions.height = parseFloat(widthHeightMatch[2]);
    }

    const finishMatch = text.match(/\b(matte|matt|glossy|gloss|emulsion|polished|satin)\b/i);
    if (finishMatch) dimensions.finish = finishMatch[1].toLowerCase();

    const brandMatch = KNOWN_BRANDS.find((brand) => text.toLowerCase().includes(brand.toLowerCase()));
    if (brandMatch) dimensions.brand = brandMatch;

    return dimensions;
  }

  // =========================================================================
  // STEP 3 - Searchable metadata (keywords / synonyms / normalized / stemmed)
  // =========================================================================

  extractKeywords(description: string): string[] {
    const cleaned = (description ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const filtered = tokens.filter((token) => token.length > 2 && !STOPWORDS.has(token));
    return Array.from(new Set(filtered));
  }

  expandSynonyms(tokens: string[]): string[] {
    const expanded = new Set(tokens);
    for (const token of tokens) {
      const synonyms = this.synonymDictionary.get(token);
      if (synonyms) synonyms.forEach((synonym) => expanded.add(synonym));
    }
    return Array.from(expanded);
  }

  private buildSynonymDictionary(): Map<string, Set<string>> {
    const dictionary = new Map<string, Set<string>>();
    for (const group of SYNONYM_GROUPS) {
      for (const token of group) {
        const set = dictionary.get(token) ?? new Set<string>();
        for (const other of group) {
          if (other !== token) set.add(other);
        }
        dictionary.set(token, set);
      }
    }
    return dictionary;
  }

  private normalizeDescription(description: string): string {
    return (description ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private stem(token: string): string {
    for (const suffix of STEM_SUFFIXES) {
      if (token.length - suffix.length >= 3 && token.endsWith(suffix)) {
        return token.slice(0, -suffix.length);
      }
    }
    return token;
  }

  private stemTokens(tokens: string[]): string[] {
    return Array.from(new Set(tokens.map((token) => this.stem(token))));
  }

  // =========================================================================
  // STEP 4 - Build Master BOQ (clustering + occurrence history)
  // =========================================================================

  private static readonly CANONICAL_DOMAINS = new Set(["civil", "interior", "electrical", "mechanical"]);

  private findBestMatchInternal(query: MasterCatalogQuery): MasterCatalogMatch | null {
    const sameDomain = this.findBestMatchAmong(
      query,
      (item) => item.domain.toLowerCase() === query.domain.toLowerCase()
    );
    if (sameDomain) return sameDomain;

    // Ad-hoc / non-canonical domains (e.g. a "Basic Rate Schedule" sheet whose name carries
    // no domain keyword at all) get a second, domain-agnostic pass. A basic material price
    // is not scoped to one domain the way a full BOQ line item's activity is.
    if (!KnowledgeBaseEngine.CANONICAL_DOMAINS.has(query.domain.toLowerCase())) {
      return this.findBestMatchAmong(query, () => true);
    }

    return null;
  }

  private findBestMatchAmong(
    query: MasterCatalogQuery,
    predicate: (item: MasterCatalogItem) => boolean
  ): MasterCatalogMatch | null {
    const queryTokens = new Set(this.expandSynonyms(this.extractKeywords(query.description)));
    let best: MasterCatalogMatch | null = null;

    for (const item of this.catalog.values()) {
      if (!predicate(item)) continue;

      if (item.canonicalDescription.trim().toLowerCase() === query.description.trim().toLowerCase()) {
        return { item, matchScore: 1, matchType: "exact" };
      }

      const itemTokens = new Set(item.searchTokens);
      const intersectionSize = Array.from(queryTokens).filter((token) => itemTokens.has(token)).length;
      const unionSize = Math.max(queryTokens.size, itemTokens.size) || 1;
      const score = intersectionSize / unionSize;

      if (score >= this.similarityThreshold && (!best || score > best.matchScore)) {
        best = { item, matchScore: score, matchType: "fuzzy" };
      }
    }

    return best;
  }

  private upsertInternal(request: MasterCatalogUpsertRequest): UpsertOutcome {
    const attributes = this.extractEngineeringAttributes(request.description);
    const dimensions = { ...attributes.dimensions, ...(request.dimensions ?? {}) };
    const keywords = this.extractKeywords(request.description);
    const synonyms = this.expandSynonyms(keywords).filter((token) => !keywords.includes(token));
    const normalizedDescription = this.normalizeDescription(request.description);
    const stemmedTokens = this.stemTokens(keywords);
    const searchTokens = Array.from(new Set([...keywords, ...synonyms, ...stemmedTokens]));

    const hasAttributes = Boolean(
      attributes.material ||
        dimensions.grade ||
        dimensions.brand ||
        dimensions.finish ||
        dimensions.thickness !== undefined ||
        dimensions.capacity !== undefined ||
        dimensions.voltage !== undefined ||
        dimensions.pipeDiameter !== undefined ||
        dimensions.diameter !== undefined
    );

    const match = this.findBestMatchInternal({
      description: request.description,
      domain: request.domain,
      unit: request.unit
    });
    const isNewItem = !match;

    let item: MasterCatalogItem;

    if (match) {
      item = match.item;
      this.deindexItem(item);
      item.keywords = Array.from(new Set([...item.keywords, ...keywords]));
      item.synonyms = Array.from(new Set([...item.synonyms, ...synonyms]));
      item.stemmedTokens = Array.from(new Set([...item.stemmedTokens, ...stemmedTokens]));
      item.searchTokens = Array.from(new Set([...item.searchTokens, ...searchTokens]));
      item.dimensions = { ...item.dimensions, ...dimensions };
      item.material = item.material ?? attributes.material;
      item.materialType = item.materialType ?? attributes.materialType;
      item.specification = item.specification ?? attributes.specification;
      item.executionMethod = item.executionMethod ?? attributes.executionMethod;
      item.category = item.category ?? attributes.category;
      item.subcategory = item.subcategory ?? this.deriveSubcategory(attributes.category, attributes.material);
      item.thickness = item.thickness ?? dimensions.thickness;
      item.capacity = item.capacity ?? dimensions.capacity;
      item.voltage = item.voltage ?? dimensions.voltage;
      item.pipeDiameter = item.pipeDiameter ?? dimensions.pipeDiameter;
      item.brand = item.brand ?? dimensions.brand;
      item.grade = item.grade ?? dimensions.grade;
      item.finish = item.finish ?? dimensions.finish;
    } else {
      item = {
        id: this.generateId("mstr"),
        canonicalDescription: request.description,
        domain: request.domain,
        category: attributes.category,
        subcategory: this.deriveSubcategory(attributes.category, attributes.material),
        material: attributes.material,
        materialType: attributes.materialType,
        specification: attributes.specification,
        brand: dimensions.brand,
        grade: dimensions.grade,
        finish: dimensions.finish,
        thickness: dimensions.thickness,
        dimensions,
        capacity: dimensions.capacity,
        voltage: dimensions.voltage,
        pipeDiameter: dimensions.pipeDiameter,
        executionMethod: attributes.executionMethod,
        uom: request.unit,
        keywords,
        synonyms,
        normalizedDescription,
        stemmedTokens,
        searchTokens,
        historicalOccurrences: [],
        basicRateOccurrences: [],
        historicalProjects: [],
        projectTypes: [],
        cities: [],
        averageRate: 0,
        medianRate: 0,
        minRate: 0,
        maxRate: 0,
        occurrenceCount: 0,
        lastUpdated: new Date().toISOString()
      };
    }

    const occurrence: HistoricalItemOccurrence = {
      ...request.rateSample,
      masterItemId: item.id,
      originalDescription: request.description
    };

    if (request.isBasicRate) {
      item.basicRateOccurrences.push(occurrence);
    } else {
      item.historicalOccurrences.push(occurrence);
    }

    if (!item.historicalProjects.includes(request.rateSample.projectName)) {
      item.historicalProjects.push(request.rateSample.projectName);
    }
    if (request.projectType && !item.projectTypes.includes(request.projectType)) {
      item.projectTypes.push(request.projectType);
    }
    if (request.city && !item.cities.includes(request.city)) {
      item.cities.push(request.city);
    }

    item = this.recomputeStatistics(item);
    this.catalog.set(item.id, item);
    this.indexItem(item);

    return { item, isNewItem, hasAttributes };
  }

  recomputeStatistics(item: MasterCatalogItem): MasterCatalogItem {
    const historicalRates = item.historicalOccurrences.map((o) => o.rate).filter((rate) => Number.isFinite(rate));
    if (historicalRates.length > 0) {
      item.minRate = Math.min(...historicalRates);
      item.maxRate = Math.max(...historicalRates);
      item.averageRate = historicalRates.reduce((sum, rate) => sum + rate, 0) / historicalRates.length;
      item.medianRate = KnowledgeBaseEngine.median(historicalRates);
    }
    item.occurrenceCount = historicalRates.length;

    const basicRates = item.basicRateOccurrences.map((o) => o.rate).filter((rate) => Number.isFinite(rate));
    if (basicRates.length > 0) {
      item.basicRate = KnowledgeBaseEngine.median(basicRates);
    }

    item.lastUpdated = new Date().toISOString();
    return item;
  }

  private static median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  async findBestMatch(query: MasterCatalogQuery): Promise<MasterCatalogMatch | null> {
    return this.findBestMatchInternal(query);
  }

  async upsertFromHistoricalRow(request: MasterCatalogUpsertRequest): Promise<MasterCatalogItem> {
    const { item } = this.upsertInternal(request);
    this.persistToDisk();
    return item;
  }

  async mergeItems(sourceId: string, targetId: string): Promise<MasterCatalogItem> {
    const source = this.catalog.get(sourceId);
    const target = this.catalog.get(targetId);
    if (!source) throw new Error(`KnowledgeBaseEngine.mergeItems: source item "${sourceId}" not found.`);
    if (!target) throw new Error(`KnowledgeBaseEngine.mergeItems: target item "${targetId}" not found.`);

    this.deindexItem(source);
    this.deindexItem(target);

    target.historicalOccurrences = [...target.historicalOccurrences, ...source.historicalOccurrences];
    target.basicRateOccurrences = [...target.basicRateOccurrences, ...source.basicRateOccurrences];
    target.keywords = Array.from(new Set([...target.keywords, ...source.keywords]));
    target.synonyms = Array.from(new Set([...target.synonyms, ...source.synonyms]));
    target.stemmedTokens = Array.from(new Set([...target.stemmedTokens, ...source.stemmedTokens]));
    target.searchTokens = Array.from(new Set([...target.searchTokens, ...source.searchTokens]));
    target.historicalProjects = Array.from(new Set([...target.historicalProjects, ...source.historicalProjects]));
    target.projectTypes = Array.from(new Set([...target.projectTypes, ...source.projectTypes]));
    target.cities = Array.from(new Set([...target.cities, ...source.cities]));

    const merged = this.recomputeStatistics(target);
    this.catalog.delete(sourceId);
    this.catalog.set(merged.id, merged);
    this.indexItem(merged);
    this.persistToDisk();
    return merged;
  }

  async getById(id: string): Promise<MasterCatalogItem | null> {
    return this.catalog.get(id) ?? null;
  }

  async list(domain?: string): Promise<MasterCatalogItem[]> {
    const items = Array.from(this.catalog.values());
    return domain ? items.filter((item) => item.domain.toLowerCase() === domain.toLowerCase()) : items;
  }

  async delete(id: string): Promise<void> {
    const item = this.catalog.get(id);
    if (!item) return;
    this.deindexItem(item);
    this.catalog.delete(id);
    this.persistToDisk();
  }

  // =========================================================================
  // STEP 5 - Searchable indexes
  // =========================================================================

  private setIndexEntry(index: Map<string, Set<string>>, value: string | undefined, itemId: string): void {
    if (!value) return;
    const key = value.toLowerCase();
    const set = index.get(key) ?? new Set<string>();
    set.add(itemId);
    index.set(key, set);
  }

  private removeIndexEntry(index: Map<string, Set<string>>, value: string | undefined, itemId: string): void {
    if (!value) return;
    const key = value.toLowerCase();
    const set = index.get(key);
    if (!set) return;
    set.delete(itemId);
    if (set.size === 0) index.delete(key);
  }

  private formatDimensionKey(item: MasterCatalogItem): string | undefined {
    if (item.dimensions.width === undefined || item.dimensions.height === undefined) return undefined;
    return `${Math.round(item.dimensions.width)}x${Math.round(item.dimensions.height)}`;
  }

  private indexItem(item: MasterCatalogItem): void {
    for (const token of item.searchTokens) {
      const ids = this.invertedIndex.get(token) ?? new Set<string>();
      ids.add(item.id);
      this.invertedIndex.set(token, ids);
    }

    this.setIndexEntry(this.materialIndex, item.material, item.id);
    this.setIndexEntry(this.specificationIndex, item.specification, item.id);
    this.setIndexEntry(this.brandIndex, item.brand, item.id);
    this.setIndexEntry(this.gradeIndex, item.grade, item.id);
    this.setIndexEntry(
      this.thicknessIndex,
      item.thickness !== undefined ? String(Math.round(item.thickness)) : undefined,
      item.id
    );
    this.setIndexEntry(this.dimensionsIndex, this.formatDimensionKey(item), item.id);
    this.setIndexEntry(this.uomIndex, item.uom, item.id);
    this.setIndexEntry(this.domainIndex, item.domain, item.id);
    this.setIndexEntry(this.categoryIndex, item.category, item.id);
    for (const projectType of item.projectTypes) this.setIndexEntry(this.projectTypeIndex, projectType, item.id);
    for (const city of item.cities) this.setIndexEntry(this.cityIndex, city, item.id);
  }

  private deindexItem(item: MasterCatalogItem): void {
    for (const token of item.searchTokens) {
      const ids = this.invertedIndex.get(token);
      if (!ids) continue;
      ids.delete(item.id);
      if (ids.size === 0) this.invertedIndex.delete(token);
    }

    this.removeIndexEntry(this.materialIndex, item.material, item.id);
    this.removeIndexEntry(this.specificationIndex, item.specification, item.id);
    this.removeIndexEntry(this.brandIndex, item.brand, item.id);
    this.removeIndexEntry(this.gradeIndex, item.grade, item.id);
    this.removeIndexEntry(
      this.thicknessIndex,
      item.thickness !== undefined ? String(Math.round(item.thickness)) : undefined,
      item.id
    );
    this.removeIndexEntry(this.dimensionsIndex, this.formatDimensionKey(item), item.id);
    this.removeIndexEntry(this.uomIndex, item.uom, item.id);
    this.removeIndexEntry(this.domainIndex, item.domain, item.id);
    this.removeIndexEntry(this.categoryIndex, item.category, item.id);
    for (const projectType of item.projectTypes) this.removeIndexEntry(this.projectTypeIndex, projectType, item.id);
    for (const city of item.cities) this.removeIndexEntry(this.cityIndex, city, item.id);
  }

  private resolveFromIndex(index: Map<string, Set<string>>, value: string): MasterCatalogItem[] {
    const ids = index.get(value.toLowerCase());
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.catalog.get(id))
      .filter((item): item is MasterCatalogItem => Boolean(item));
  }

  async search(keyword: string, domain?: string): Promise<MasterCatalogItem[]> {
    const tokens = this.expandSynonyms(this.extractKeywords(keyword));
    const tally = new Map<string, number>();

    for (const token of tokens) {
      const ids = this.invertedIndex.get(token);
      if (!ids) continue;
      for (const id of ids) {
        tally.set(id, (tally.get(id) ?? 0) + 1);
      }
    }

    return Array.from(tally.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => this.catalog.get(id))
      .filter((item): item is MasterCatalogItem => Boolean(item))
      .filter((item) => !domain || item.domain.toLowerCase() === domain.toLowerCase());
  }

  async findByMaterial(material: string): Promise<MasterCatalogItem[]> {
    return this.resolveFromIndex(this.materialIndex, material);
  }

  async findBySpecification(specification: string): Promise<MasterCatalogItem[]> {
    return this.resolveFromIndex(this.specificationIndex, specification);
  }

  async findByBrand(brand: string): Promise<MasterCatalogItem[]> {
    return this.resolveFromIndex(this.brandIndex, brand);
  }

  async findByGrade(grade: string): Promise<MasterCatalogItem[]> {
    return this.resolveFromIndex(this.gradeIndex, grade);
  }

  async findByThickness(thicknessMm: number): Promise<MasterCatalogItem[]> {
    return this.resolveFromIndex(this.thicknessIndex, String(Math.round(thicknessMm)));
  }

  async findByDimensions(widthMm: number, heightMm: number): Promise<MasterCatalogItem[]> {
    return this.resolveFromIndex(this.dimensionsIndex, `${Math.round(widthMm)}x${Math.round(heightMm)}`);
  }

  async findByUOM(uom: string): Promise<MasterCatalogItem[]> {
    return this.resolveFromIndex(this.uomIndex, uom);
  }

  async findByDomain(domain: string): Promise<MasterCatalogItem[]> {
    return this.resolveFromIndex(this.domainIndex, domain);
  }

  async findByCategory(category: string): Promise<MasterCatalogItem[]> {
    return this.resolveFromIndex(this.categoryIndex, category);
  }

  async findByProjectType(projectType: string): Promise<MasterCatalogItem[]> {
    return this.resolveFromIndex(this.projectTypeIndex, projectType);
  }

  async findByCity(city: string): Promise<MasterCatalogItem[]> {
    return this.resolveFromIndex(this.cityIndex, city);
  }

  // =========================================================================
  // Persistence (dedicated store file, never the legacy *_store.json)
  // =========================================================================

  private generateId(prefix: string): string {
    return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.storageFilePath)) return;
      const raw = fs.readFileSync(this.storageFilePath, "utf-8");
      const snapshot = JSON.parse(raw) as {
        catalog?: MasterCatalogItem[];
        projectMetadata?: ProjectMetadataRecord[];
      };

      for (const item of snapshot.catalog ?? []) {
        this.catalog.set(item.id, item);
        this.indexItem(item);
      }
      for (const record of snapshot.projectMetadata ?? []) {
        this.projectMetadata.set(record.projectId, record);
      }
    } catch (error) {
      console.error("[KnowledgeBaseEngine] Failed to load existing store, starting empty.", error);
    }
  }

  private persistToDisk(): void {
    try {
      const dir = path.dirname(this.storageFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const snapshot = {
        catalog: Array.from(this.catalog.values()),
        projectMetadata: Array.from(this.projectMetadata.values())
      };

      fs.writeFileSync(this.storageFilePath, JSON.stringify(snapshot, null, 2), "utf-8");
    } catch (error) {
      console.error("[KnowledgeBaseEngine] Failed to persist store to disk.", error);
    }
  }
}
