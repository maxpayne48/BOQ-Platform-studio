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
  // Every column whose header text classified as description-like, in column order. Real BOQs
  // frequently carry TWO such columns (e.g. COWRKS: B="ITEM" short label, D="DESCRIPTION" full
  // spec text) - the leftmost is not reliably the real one, so the parser disambiguates by body
  // content (see resolveDescriptionColumn) instead of trusting header order.
  descriptionCandidates?: number[];
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
  const descriptionCandidates: number[] = [];
  for (let col = 1; col < cellTexts.length; col++) {
    const category = classifyHeaderCell(cellTexts[col] || "");
    if (!category) continue;
    if (category === "description") descriptionCandidates.push(col);
    // First match wins per category (leftmost column of that kind), so a repeated/merged label
    // spanning several columns doesn't overwrite an already-found column.
    if (map[category] === null) map[category] = col;
  }
  map.descriptionCandidates = descriptionCandidates;

  // Split-rate BOQ convention (found live on COWRKS's FAS sheet, general to any Supply/Erection
  // split layout): the quantity column is headed just "TOTAL" (total quantity), with the split
  // SUPPLY/ERECTION/TOTAL sub-headers living one row below under "UNIT RATE"/"TOTAL AMOUNT"
  // group headers. "TOTAL" classifies as an amount keyword, leaving quantity undetected and the
  // whole sheet skipped. Structural disambiguation, no sheet/domain names involved: a genuine
  // amount column NEVER sits to the LEFT of the rate column (amount = qty x rate, always after) -
  // so an "amount" match left of the detected rate column is really the quantity column. A
  // replacement amount column, if any, is re-scanned strictly to the right of the rate column.
  if (map.quantity === null && map.rate !== null && map.amount !== null && map.amount < map.rate) {
    map.quantity = map.amount;
    map.amount = null;
    for (let col = map.rate + 1; col < cellTexts.length; col++) {
      if (classifyHeaderCell(cellTexts[col] || "") === "amount") {
        map.amount = col;
        break;
      }
    }
  }
  return map;
}

// Content-based disambiguation between multiple description-like header columns (e.g. COWRKS
// C&I: B="ITEM" carries a short ALL-CAPS label, D="DESCRIPTION" carries the actual specification
// text; historical ingestion reads D, so an RFQ parse reading B breaks item identity matching
// catalog-wide). Header text alone cannot break the tie - the BODY content can: the real
// description column has, by far, the longest average text across the section's data rows.
function resolveDescriptionColumn(
  candidates: number[],
  bodyRows: string[][],
  sampleLimit: number
): number | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  let bestCol = candidates[0];
  let bestAvg = -1;
  for (const col of candidates) {
    let total = 0;
    let counted = 0;
    for (let i = 0; i < bodyRows.length && counted < sampleLimit; i++) {
      const text = (bodyRows[i][col] || "").trim();
      if (!text) continue;
      total += text.length;
      counted++;
    }
    const avg = counted > 0 ? total / counted : 0;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestCol = col;
    }
  }
  return bestCol;
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

  // Two-pass parse. Pass 1 collects every non-blank row's cell texts; pass 2 does the actual
  // header/section detection and item extraction. The second pass needs the FULL row list up
  // front because a section's description column can only be resolved by looking at the body
  // rows BELOW its header (see resolveDescriptionColumn) - a single streaming pass would have to
  // commit to a description column before seeing any of the evidence needed to pick it.
  const collectedRows: { rowNum: number; cellTexts: string[] }[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    const lastCol = Math.min(row.cellCount || 0, MAX_COLUMNS_PER_ROW);
    const cellTexts: string[] = [""];
    for (let col = 1; col <= lastCol; col++) {
      cellTexts[col] = getCellText(row.getCell(col).value);
    }
    const isRowBlank = cellTexts.every((t) => !t || !t.trim());
    if (isRowBlank) return; // blank separator rows are expected, never an error
    collectedRows.push({ rowNum, cellTexts });
  });

  const DESCRIPTION_SAMPLE_ROWS = 40;

  for (let rowIdx = 0; rowIdx < collectedRows.length; rowIdx++) {
    const { rowNum, cellTexts } = collectedRows[rowIdx];
    log.rowsScanned++;

    // Always check for a NEW section header, even mid-sheet - supports multiple BOQ sections
    // and multiple header rows within one worksheet.
    const candidateMap = detectColumnMap(cellTexts);
    if (isValidHeaderCandidate(candidateMap)) {
      // Resolve which description-like column is the REAL description by body content of the
      // rows below this header (up to the sample limit) - never by header order alone.
      const bodyBelow = collectedRows.slice(rowIdx + 1, rowIdx + 1 + DESCRIPTION_SAMPLE_ROWS * 2).map((r) => r.cellTexts);
      candidateMap.description = resolveDescriptionColumn(
        candidateMap.descriptionCandidates || [],
        bodyBelow,
        DESCRIPTION_SAMPLE_ROWS
      ) ?? candidateMap.description;
      currentColumnMap = candidateMap;
      log.sectionsDetected++;
      log.headerRows.push(rowNum);
      log.detectedColumns.push(candidateMap);
      currentHierarchy = [];
      continue;
    }

    if (!currentColumnMap) continue; // pre-header content (titles, metadata) - skip silently

    const desc = currentColumnMap.description !== null ? (cellTexts[currentColumnMap.description] || "").trim() : "";
    const qtyRaw = currentColumnMap.quantity !== null ? cellTexts[currentColumnMap.quantity] || "" : "";
    const unit = currentColumnMap.unit !== null ? (cellTexts[currentColumnMap.unit] || "").trim() : "";
    const itemNo = currentColumnMap.itemNo !== null ? (cellTexts[currentColumnMap.itemNo] || "").trim() : "";

    if (!desc) {
      log.rowsSkipped++;
      bump(log.skippedReasons, "Missing description");
      continue;
    }

    if (isTotalOrSummaryRow(desc)) {
      log.rowsSkipped++;
      bump(log.skippedReasons, "Total/summary row");
      continue;
    }

    let qty = parseQuantity(qtyRaw);
    if (qty === null) {
      // A blank quantity does NOT by itself mean "section label". Two real, common BOQ layouts
      // produce a genuine priced line item with an unreadable quantity cell:
      //   - the quantity column is a formula (e.g. TOTAL QUANTITY = SUM of per-floor breakdown
      //     columns) whose cached result the writing tool never stored, so it reads as empty;
      //   - the sheet quotes a rate card where quantity is deliberately left blank.
      // Keppel's BOQ sheets are the live case: every priced row has a description, a unit and a
      // rate, but its TOTAL QUANTITY formula has no cached value - reclassifying all of them as
      // hierarchy labels discarded 389 of 473 ground-truth rows (82%) from that project.
      // A true section label ("1.2 Flooring Works") has a description and nothing else, so the
      // presence of a unit AND a numeric rate/amount on the same row is what separates the two.
      // Quantity is not an input to rate recommendation, so admitting these at quantity 0 (the
      // same value already used for legitimately zero-quantity rate-card rows elsewhere) recovers
      // the item without inventing data.
      // The unit-of-measure cell is the discriminator: a priced/priceable BOQ line always carries
      // one ("Sqmt", "Nos.", "Rmt"), while a section label ("DEMOLITION & PROTECTION WORKS",
      // "1.2 Flooring Works") never does. Deliberately NOT also requiring a rate/amount on the row -
      // an RFQ awaiting pricing has empty rate cells by definition, which is exactly the population
      // this parser exists to extract.
      if (!unit) {
        // Genuine hierarchy/section label - same grouping behavior as before.
        if (itemNo && /^\d+(\.\d+)*$/.test(itemNo)) {
          const depth = itemNo.split(".").length;
          currentHierarchy = currentHierarchy.slice(0, depth - 1);
          currentHierarchy.push(desc);
        } else if (desc.length < 100) {
          currentHierarchy.push(desc);
          if (currentHierarchy.length > 3) currentHierarchy.shift();
        }
        continue;
      }
      qty = 0;
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
  }

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

// Some third-party tools (Google Sheets export, LibreOffice, various xlsx writer libraries) emit
// xl/drawings/drawingN.xml with every element bound to the default (unprefixed) namespace instead
// of the "xdr:" prefix real Excel always writes. ExcelJS's drawing parser matches tag names
// literally ("xdr:wsDr", "xdr:oneCellAnchor", ...) rather than resolving XML namespaces, so it
// silently fails to populate the drawing model on these files and later crashes trying to read
// `.anchors` off `undefined` (during ExcelJS's own workbook reconcile step). Rewriting bare tag
// names to carry the "xdr:" prefix is a no-op for normal, already-prefixed files - Excel itself
// opens files in either style identically - and fixes the crash for this entire class of workbook.
function normalizeDrawingXmlNamespace(xml: string): string {
  if (!/<wsDr[\s>]/.test(xml)) {
    return xml;
  }
  return xml.replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/g, (_match, slash, tagName) => `<${slash}xdr:${tagName}`);
}

// Cell comments (and their VML anchor drawings) are pure annotation metadata - nothing in BOQ item
// extraction, blueprint generation, or rate injection reads them. ExcelJS, however, only indexes
// comment parts written at the exact paths IT emits: `xl/commentsN.xml` (keyed `../commentsN.xml`)
// and `xl/drawings/vmlDrawingN.vml`. The equally-legal layout other writers produce -
// `xl/comments/commentN.xml` + `xl/drawings/commentsDrawingN.vml`, seen live on the DHL Chennai
// workbook - never matches those regexes, so the lookup maps stay EMPTY while the worksheet still
// carries a Comments relationship. ExcelJS then dereferences `options.comments[rel.Target].comments`
// on `undefined` and the ENTIRE workbook fails to load, silently dropping the file to the legacy
// fixed-position fallback parser (or failing upload outright). Dropping just these two relationship
// types is the minimal repair: the comment parts themselves stay in the zip untouched, and because
// this normalization is applied ONLY to the bytes handed to ExcelJS - never to the bytes saved to
// uploads/ or patched at export time - the user's exported workbook keeps every comment intact.
function stripUnindexableCommentRels(xml: string): string {
  return xml.replace(
    /<Relationship\b[^>]*\bType="[^"]*\/(?:comments|vmlDrawing)"[^>]*\/>/g,
    ""
  );
}

// Applies both ExcelJS-compatibility workarounds above across the workbook zip. Returns the
// original buffer unchanged if nothing needed fixing, so callers can cheaply detect "was this
// rewritten". EXCELJS-FACING ONLY - never persist or export the result (see the comment note above).
export async function normalizeWorkbookForExcelJs(fileBuf: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fileBuf);
  } catch {
    return fileBuf;
  }

  let changed = false;
  for (const filePath of Object.keys(zip.files)) {
    let original: string | null = null;
    let fixed: string | null = null;

    if (/^xl\/drawings\/drawing\d+\.xml$/.test(filePath)) {
      original = await zip.file(filePath)!.async("string");
      fixed = normalizeDrawingXmlNamespace(original);
    } else if (/^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(filePath)) {
      original = await zip.file(filePath)!.async("string");
      fixed = stripUnindexableCommentRels(original);
    }

    if (original !== null && fixed !== null && fixed !== original) {
      zip.file(filePath, fixed);
      changed = true;
    }
  }

  return changed ? await zip.generateAsync({ type: "nodebuffer" }) : fileBuf;
}

// Note: this function deliberately does NOT apply normalizeWorkbookForExcelJs. Its `cleanedBuffer`
// is what callers PERSIST to uploads/ and later patch at export time, so it must stay a faithful
// copy of the user's workbook apart from the genuine defined-names repair below. The ExcelJS-only
// compatibility workarounds are applied separately, at each point where bytes are handed to
// ExcelJS, and never persisted.
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
