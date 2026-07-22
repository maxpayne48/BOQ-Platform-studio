import ExcelJS from "exceljs";
import JSZip from "jszip";

// Universal BOQ Upload Parser - replaces the old client-flattened-array, fixed-column-position
// item extraction that only worked for workbooks shaped like the historical templates already in
// the database. This module is used ONLY by the RFQ upload pipeline (POST /api/rfqs in
// server.ts). It never touches the Recommendation Engine, Pricing Engine, Historical Database,
// Master BOQ, or Export Logic (generateWorkbookBlueprint) - it only produces a better-quality,
// more resilient `ExtractedRow[]` that server.ts assembles into RFQItem[] exactly as before.
//
// Reading via ExcelJS (rather than the client's SheetJS-flattened arrays) is what makes merged
// cells "just work": ExcelJS automatically returns the master cell's value for every cell inside
// a merged range, so no custom merge-resolution code is needed at all.

export interface ColumnMap {
  description: number | null;
  quantity: number | null;
  unit: number | null;
  rate: number | null;
  amount: number | null;
  itemNo: number | null;
}

export interface ExtractedRow {
  sheetName: string;
  rowNum: number; // 1-based, exact ExcelJS row number
  itemNo: string;
  description: string;
  unit: string;
  quantity: number;
  parentHierarchy: string[];
}

export interface SheetParseLog {
  sheetName: string;
  status: "Parsed" | "Skipped" | "Failed";
  skipReason?: string;
  sectionsDetected: number;
  headerRows: number[];
  detectedColumns: ColumnMap[];
  rowsScanned: number;
  rowsParsed: number;
  rowsSkipped: number;
  skippedReasons: Record<string, number>;
  warnings: string[];
}

// The four diagnostic categories this pipeline distinguishes, per the upload report requirements:
//  - "Metadata Warning": the workbook opened and parsed fine, but had bloated/excessive internal
//    Excel metadata (orphaned defined names, etc.) - informational only, never blocks the upload.
//  - "Parsing Error": an exception while parsing a specific worksheet - that sheet is skipped, the
//    rest of the workbook still parses.
//  - "Workbook Corruption": the file itself could not be opened/read at all.
//  - "Missing BOQ Data": the workbook (or a given worksheet) opened and parsed without error, but
//    no recognizable Description + Quantity data could be found.
export type DiagnosticCategory = "Metadata Warning" | "Parsing Error" | "Workbook Corruption" | "Missing BOQ Data";

export interface DiagnosticEntry {
  category: DiagnosticCategory;
  sheetName?: string;
  message: string;
}

export interface UploadLog {
  workbookRead: boolean;
  worksheetsFound: string[];
  worksheetsParsed: string[];
  worksheetsSkipped: { sheetName: string; reason: string }[];
  totalRowsParsed: number;
  totalRowsSkipped: number;
  skippedReasonSummary: Record<string, number>;
  headerDetectionResults: { sheetName: string; headerRows: number[]; columns: ColumnMap[] }[];
  perSheet: SheetParseLog[];
  parsingTimeMs: number;
  warnings: string[];
  errors: string[];
  diagnostics: DiagnosticEntry[];
  metadataWarning?: string;
  definedNamesRemoved?: number;
}

export interface BOQParseResult {
  items: ExtractedRow[];
  uploadLog: UploadLog;
}

// Fast-path name check only - deliberately narrow, matching exactly what the user asked to
// exclude by name. Everything else is decided by CONTENT: a sheet with no detectable BOQ header
// (Description + Quantity columns) simply yields zero items and is logged as skipped, without
// needing a fragile "is this a notes page" heuristic.
const NAME_SKIP_KEYWORDS = ["drawing", "image", "photo", "picture", "logo", "cover", "index"];

function shouldSkipSheetByName(sheetName: string): { skip: boolean; reason?: string } {
  const lower = sheetName.toLowerCase();
  for (const kw of NAME_SKIP_KEYWORDS) {
    if (lower.includes(kw)) return { skip: true, reason: `Sheet name indicates non-BOQ content ("${kw}")` };
  }
  return { skip: false };
}

function getCellText(cellValue: any): string {
  if (cellValue === null || cellValue === undefined) return "";
  if (typeof cellValue === "object") {
    if (cellValue instanceof Date) return cellValue.toLocaleDateString();
    if ("result" in cellValue) return String(cellValue.result ?? "");
    if ("formula" in cellValue) return String(cellValue.result ?? "");
    if ("richText" in cellValue && Array.isArray(cellValue.richText)) {
      return cellValue.richText.map((t: any) => t.text || "").join("");
    }
    if ("text" in cellValue) return String(cellValue.text ?? "");
    return "";
  }
  return String(cellValue);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const ITEMNO_KEYWORDS = ["slno", "sno", "srno", "serialno", "itemcode", "itemnumber", "itemno"];
const QUANTITY_KEYWORDS = ["quantityrequired", "quantity", "qty", "qnty"];
const UNIT_KEYWORDS = ["unitofmeasurement", "measurement", "uom", "unit"];
const RATE_KEYWORDS = ["unitrate", "basicrate", "unitprice", "rate", "price"];
const AMOUNT_KEYWORDS = ["totalamount", "totalvalue", "amount", "value", "total"];
const DESCRIPTION_KEYWORDS = ["itemdescription", "workdescription", "boqdescription", "itemdetails", "description", "particulars", "particular", "scope", "activity", "item"];

const MAX_HEADER_CELL_LENGTH = 40; // real header labels are short; long text is body content, not
// a column heading, even if it happens to contain a keyword substring.

type ColumnCategory = "itemNo" | "quantity" | "unit" | "rate" | "amount" | "description" | null;

function classifyHeaderCell(rawText: string): ColumnCategory {
  const text = rawText.trim();
  if (!text || text.length > MAX_HEADER_CELL_LENGTH) return null;
  const n = normalize(text);
  if (!n) return null;

  // Priority order matters: more specific categories are checked first so a generic substring
  // (e.g. "item" inside "item no") never misclassifies a more specific column.
  if (ITEMNO_KEYWORDS.some((k) => n === k || n.includes(k))) return "itemNo";
  if (QUANTITY_KEYWORDS.some((k) => n.includes(k))) return "quantity";
  if (RATE_KEYWORDS.some((k) => n.includes(k))) return "rate";
  if (AMOUNT_KEYWORDS.some((k) => n.includes(k))) return "amount";
  if (UNIT_KEYWORDS.some((k) => n.includes(k)) && !n.includes("rate") && !n.includes("price")) return "unit";
  if (DESCRIPTION_KEYWORDS.some((k) => n === k || n.includes(k))) return "description";
  return null;
}

function detectColumnMap(cellTexts: string[]): ColumnMap {
  const map: ColumnMap = { description: null, quantity: null, unit: null, rate: null, amount: null, itemNo: null };
  for (let col = 1; col < cellTexts.length; col++) {
    const category = classifyHeaderCell(cellTexts[col] || "");
    if (!category) continue;
    // First match wins per category (leftmost column of that kind), so a repeated/merged label
    // spanning several columns doesn't overwrite an already-found column.
    if (map[category] === null) map[category] = col;
  }
  return map;
}

// A row only counts as a genuine BOQ section header if it has BOTH a description-like column and
// a quantity-like column - the two pieces of "mandatory BOQ information" per the redesign spec.
function isValidHeaderCandidate(map: ColumnMap): boolean {
  return map.description !== null && map.quantity !== null;
}

function parseQuantity(raw: string): number | null {
  if (!raw || !raw.trim()) return null;
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function isTotalOrSummaryRow(desc: string): boolean {
  const n = desc.toLowerCase().trim();
  return (
    /^(grand\s*)?(sub\s*)?-?\s*total\b/.test(n) ||
    n.startsWith("carried forward") ||
    n.startsWith("brought forward") ||
    n === "c/f" ||
    n === "b/f"
  );
}

function bump(record: Record<string, number>, reason: string): void {
  record[reason] = (record[reason] || 0) + 1;
}

function parseWorksheet(worksheet: ExcelJS.Worksheet): { items: ExtractedRow[]; log: SheetParseLog } {
  const log: SheetParseLog = {
    sheetName: worksheet.name,
    status: "Skipped",
    sectionsDetected: 0,
    headerRows: [],
    detectedColumns: [],
    rowsScanned: 0,
    rowsParsed: 0,
    rowsSkipped: 0,
    skippedReasons: {},
    warnings: []
  };

  const items: ExtractedRow[] = [];
  let currentColumnMap: ColumnMap | null = null;
  let currentHierarchy: string[] = [];

  // Deliberately NOT a `for (rowNum = 1; rowNum <= worksheet.rowCount; ...)` loop:
  // worksheet.rowCount/columnCount reflect Excel's "used range", which can be wildly inflated by
  // formatting applied to entire empty columns/rows (a common export artifact) - iterating to
  // that count would force ExcelJS to materialize millions of phantom row/cell objects and
  // exhaust memory. `eachRow({ includeEmpty: false })` walks only rows that actually have a
  // value, which is both correct and safe regardless of a workbook's declared used-range size.
  const MAX_COLUMNS_PER_ROW = 60; // generous ceiling for any realistic BOQ column layout

  worksheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    const lastCol = Math.min(row.cellCount || 0, MAX_COLUMNS_PER_ROW);
    const cellTexts: string[] = [""];
    for (let col = 1; col <= lastCol; col++) {
      cellTexts[col] = getCellText(row.getCell(col).value);
    }

    const isRowBlank = cellTexts.every((t) => !t || !t.trim());
    if (isRowBlank) return; // blank separator rows are expected, never an error

    log.rowsScanned++;

    // Always check for a NEW section header, even mid-sheet - supports multiple BOQ sections
    // and multiple header rows within one worksheet.
    const candidateMap = detectColumnMap(cellTexts);
    if (isValidHeaderCandidate(candidateMap)) {
      currentColumnMap = candidateMap;
      log.sectionsDetected++;
      log.headerRows.push(rowNum);
      log.detectedColumns.push(candidateMap);
      currentHierarchy = [];
      return;
    }

    if (!currentColumnMap) return; // pre-header content (titles, metadata) - skip silently

    const desc = currentColumnMap.description !== null ? (cellTexts[currentColumnMap.description] || "").trim() : "";
    const qtyRaw = currentColumnMap.quantity !== null ? cellTexts[currentColumnMap.quantity] || "" : "";
    const unit = currentColumnMap.unit !== null ? (cellTexts[currentColumnMap.unit] || "").trim() : "";
    const itemNo = currentColumnMap.itemNo !== null ? (cellTexts[currentColumnMap.itemNo] || "").trim() : "";

    if (!desc) {
      log.rowsSkipped++;
      bump(log.skippedReasons, "Missing description");
      return;
    }

    if (isTotalOrSummaryRow(desc)) {
      log.rowsSkipped++;
      bump(log.skippedReasons, "Total/summary row");
      return;
    }

    const qty = parseQuantity(qtyRaw);
    if (qty === null) {
      // No usable quantity - treat as a hierarchy/section label (e.g. "1.2 Flooring Works"),
      // exactly like the previous implementation's grouping behavior, not an error.
      if (itemNo && /^\d+(\.\d+)*$/.test(itemNo)) {
        const depth = itemNo.split(".").length;
        currentHierarchy = currentHierarchy.slice(0, depth - 1);
        currentHierarchy.push(desc);
      } else if (desc.length < 100) {
        currentHierarchy.push(desc);
        if (currentHierarchy.length > 3) currentHierarchy.shift();
      }
      return;
    }

    items.push({
      sheetName: worksheet.name,
      rowNum,
      itemNo: itemNo || String(items.length + 1),
      description: desc,
      unit,
      quantity: qty,
      parentHierarchy: [...currentHierarchy]
    });
    log.rowsParsed++;
  });

  if (log.sectionsDetected === 0) {
    log.status = "Skipped";
    log.skipReason = "No BOQ header row detected (no column pairing description + quantity found anywhere in this sheet)";
  } else if (items.length === 0) {
    log.status = "Skipped";
    log.skipReason = "Header row(s) detected but no valid data rows found beneath them";
  } else {
    log.status = "Parsed";
  }

  return { items, log };
}

// Pipeline Stage 1: Workbook Validation & Sanitization. Runs BEFORE any ExcelJS parsing is
// attempted, directly on the raw file bytes via a lightweight ZIP peek (JSZip).
//
// Real-world consultant BOQs routinely accumulate tens of thousands of orphaned/corrupted
// <definedName> entries from years of copy-pasting between workbooks - these bloat xl/workbook.xml
// into many megabytes. Loading such a file with ExcelJS's normal full-model parse does not throw a
// catchable error - it runs the Node process out of heap memory and crashes the entire server,
// taking down every other in-flight request with it.
//
// The fix is NOT to reject these workbooks (they open fine in Excel and contain perfectly good BOQ
// data) - it's to strip the bloated, orphaned <definedNames> block out of the raw XML before
// ExcelJS ever sees it. Defined names are named cell/range references; nothing in BOQ item
// extraction (worksheet discovery, header/column detection, row reading, merged cells) depends on
// them, so removing them is safe and has zero effect on the extracted data. This is "ignore
// unnecessary workbook metadata", not "validate Excel perfection".
const METADATA_WARNING_THRESHOLD_BYTES = 1 * 1024 * 1024; // workbook.xml above this is worth a
// user-facing warning (normal workbook.xml is a few KB), but never a rejection by itself.
const DEFINED_NAME_WARNING_THRESHOLD = 200;
// Safety net only: if even AFTER stripping the bloated defined names the workbook's core
// structure is still this large, something other than the well-understood defined-names
// corruption pattern is going on, and it genuinely isn't safe to hand to ExcelJS.
const WORKBOOK_XML_HARD_LIMIT_AFTER_CLEAN_BYTES = 10 * 1024 * 1024;

export type WorkbookValidationCategory = "None" | "Metadata Warning" | "Workbook Corruption";

export interface WorkbookValidationResult {
  valid: boolean;
  category: WorkbookValidationCategory;
  message?: string; // warning text (category "Metadata Warning") or failure reason ("Workbook Corruption")
  cleanedBuffer?: Buffer; // present whenever sanitization changed the bytes - callers must parse THIS, not the original, buffer
  definedNamesRemoved?: number;
}

export async function validateAndSanitizeWorkbook(fileBuf: Buffer): Promise<WorkbookValidationResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fileBuf);
  } catch (err: any) {
    return { valid: false, category: "Workbook Corruption", message: `This file could not be opened as a valid Excel workbook (${err?.message || err}).` };
  }

  const workbookXmlFile = zip.file("xl/workbook.xml");
  if (!workbookXmlFile) {
    return { valid: false, category: "Workbook Corruption", message: "This file does not appear to be a valid .xlsx workbook (missing xl/workbook.xml)." };
  }

  let workbookXml: string;
  try {
    workbookXml = await workbookXmlFile.async("string");
  } catch (err: any) {
    return { valid: false, category: "Workbook Corruption", message: `This workbook's internal structure could not be read (${err?.message || err}).` };
  }

  const originalSize = workbookXml.length;
  if (originalSize <= METADATA_WARNING_THRESHOLD_BYTES) {
    return { valid: true, category: "None" };
  }

  const definedNameCount = (workbookXml.match(/<definedName[\s>]/g) || []).length;

  // Attempt the clean regardless of exactly how large it is - orphaned defined names are the
  // known, common cause, and removing them is always safe to try.
  const sanitizedXml = workbookXml.replace(/<definedNames>[\s\S]*?<\/definedNames>/, "");
  const wasCleaned = sanitizedXml.length < workbookXml.length;

  if (wasCleaned && sanitizedXml.length > WORKBOOK_XML_HARD_LIMIT_AFTER_CLEAN_BYTES) {
    // Even after removing the defined names, something else is bloating this file to a size that
    // isn't safe to parse - a genuine corruption case, not just "too much metadata".
    return {
      valid: false,
      category: "Workbook Corruption",
      message: `This workbook's internal structure remains abnormally large (${(sanitizedXml.length / (1024 * 1024)).toFixed(1)}MB) even after removing ${definedNameCount.toLocaleString()} named ranges, and cannot be safely processed. Please open the file in Excel and use File > Save As to save a clean copy, then re-upload.`
    };
  }

  if (!wasCleaned && originalSize > WORKBOOK_XML_HARD_LIMIT_AFTER_CLEAN_BYTES) {
    // Large workbook.xml with no defined-names bloat to remove - an unrecognized, genuinely
    // unsafe case.
    return {
      valid: false,
      category: "Workbook Corruption",
      message: `This workbook's internal structure is abnormally large (${(originalSize / (1024 * 1024)).toFixed(1)}MB) and cannot be safely processed. Please open the file in Excel and use File > Save As to save a clean copy, then re-upload.`
    };
  }

  const message = definedNameCount > DEFINED_NAME_WARNING_THRESHOLD
    ? `This workbook contains excessive internal Excel metadata (${definedNameCount.toLocaleString()} named ranges, likely from repeated copy-pasting between workbooks). Parsing may be slower, but the application will attempt to extract the BOQ.` +
      (wasCleaned ? " Orphaned named ranges were removed before parsing to avoid a slow/unsafe parse." : "")
    : `This workbook contains excessive internal Excel metadata (${(originalSize / (1024 * 1024)).toFixed(1)}MB). Parsing may be slower, but the application will attempt to extract the BOQ.`;

  if (!wasCleaned) {
    return { valid: true, category: "Metadata Warning", message };
  }

  zip.file("xl/workbook.xml", sanitizedXml);
  const cleanedBuffer = await zip.generateAsync({ type: "nodebuffer" });
  return { valid: true, category: "Metadata Warning", message, cleanedBuffer, definedNamesRemoved: definedNameCount };
}

export function parseWorkbookForUpload(workbook: ExcelJS.Workbook): BOQParseResult {
  const startTime = Date.now();
  const uploadLog: UploadLog = {
    workbookRead: true,
    worksheetsFound: workbook.worksheets.map((w) => w.name),
    worksheetsParsed: [],
    worksheetsSkipped: [],
    totalRowsParsed: 0,
    totalRowsSkipped: 0,
    skippedReasonSummary: {},
    headerDetectionResults: [],
    perSheet: [],
    parsingTimeMs: 0,
    warnings: [],
    errors: [],
    diagnostics: []
  };

  const allItems: ExtractedRow[] = [];

  for (const worksheet of workbook.worksheets) {
    // Requirement 5: one malformed worksheet must never fail the whole upload.
    try {
      if (worksheet.state === "hidden" || worksheet.state === "veryHidden") {
        uploadLog.worksheetsSkipped.push({ sheetName: worksheet.name, reason: "Hidden worksheet" });
        continue;
      }

      const nameCheck = shouldSkipSheetByName(worksheet.name);
      if (nameCheck.skip) {
        uploadLog.worksheetsSkipped.push({ sheetName: worksheet.name, reason: nameCheck.reason! });
        continue;
      }

      const { items, log } = parseWorksheet(worksheet);

      uploadLog.perSheet.push(log);
      uploadLog.headerDetectionResults.push({ sheetName: worksheet.name, headerRows: log.headerRows, columns: log.detectedColumns });
      uploadLog.totalRowsParsed += log.rowsParsed;
      uploadLog.totalRowsSkipped += log.rowsSkipped;
      for (const [reason, count] of Object.entries(log.skippedReasons)) {
        uploadLog.skippedReasonSummary[reason] = (uploadLog.skippedReasonSummary[reason] || 0) + count;
      }

      if (log.status === "Parsed") {
        uploadLog.worksheetsParsed.push(worksheet.name);
        allItems.push(...items);
      } else {
        const reason = log.skipReason || "Not recognized as BOQ data";
        uploadLog.worksheetsSkipped.push({ sheetName: worksheet.name, reason });
        uploadLog.diagnostics.push({ category: "Missing BOQ Data", sheetName: worksheet.name, message: reason });
      }
    } catch (err: any) {
      const message = err?.message || String(err);
      uploadLog.errors.push(`Worksheet "${worksheet.name}": ${message}`);
      uploadLog.diagnostics.push({ category: "Parsing Error", sheetName: worksheet.name, message });
      uploadLog.worksheetsSkipped.push({ sheetName: worksheet.name, reason: `Parsing error: ${message}` });
      uploadLog.perSheet.push({
        sheetName: worksheet.name,
        status: "Failed",
        skipReason: message,
        sectionsDetected: 0,
        headerRows: [],
        detectedColumns: [],
        rowsScanned: 0,
        rowsParsed: 0,
        rowsSkipped: 0,
        skippedReasons: {},
        warnings: []
      });
      // Continue to the next worksheet - never abort the whole upload here.
    }
  }

  if (allItems.length === 0) {
    if (uploadLog.worksheetsFound.length === 0) {
      uploadLog.errors.push("The workbook contains no worksheets.");
      uploadLog.diagnostics.push({ category: "Workbook Corruption", message: "The workbook contains no worksheets." });
    } else if (uploadLog.worksheetsParsed.length === 0) {
      const message = "No quantity column detected in any worksheet. Verify the workbook contains recognizable Description and Quantity columns.";
      uploadLog.warnings.push(message);
      uploadLog.diagnostics.push({ category: "Missing BOQ Data", message });
    } else {
      const message = "Worksheets were parsed but no valid BOQ line items were extracted.";
      uploadLog.warnings.push(message);
      uploadLog.diagnostics.push({ category: "Missing BOQ Data", message });
    }
  }

  uploadLog.parsingTimeMs = Date.now() - startTime;
  return { items: allItems, uploadLog };
}
