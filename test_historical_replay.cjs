// Automated cross-project self-replay regression suite (rebuilt 2026-07-27; the previous
// single-project version - which read an already-uploaded RFQ from rfq_items_store.json and
// referenced fields retired by ADR-0001 - is superseded by this file).
//
// For every historical project in the database (or one, if named on the command line), this
// script:
//   1. Reconstructs that project's own BOQ as a fresh .xlsx workbook, built directly from its
//      ground-truth row mappings (historical_sheets_store/mappings_<histId>.json) - the same
//      description/unit/quantity/sheet/row data the original historical upload extracted, so
//      this is a faithful stand-in for "the user re-uploads the historical BOQ" without needing
//      the original binary file (which isn't retained for historical uploads).
//   2. Uploads it via the real POST /api/rfqs endpoint (exercising the actual upload/parse
//      pipeline, not a shortcut) and runs the real POST /api/rfqs/:id/recommend pipeline -
//      exactly what a user does when re-uploading a historical BOQ as a test.
//   3. Joins every resulting RFQItem back to its originating mapping row by (sheetName, rowNum) -
//      exact and unambiguous, since this script controls exactly which Excel row each mapping
//      landed on.
//   4. Reports, per project and combined: total items with valid ground truth, how many got NO
//      rate at all (Manual Pricing - not a "miss") vs. an auto-populated rate (which CAN be a
//      miss), and of the auto-populated ones, how many are within 1% (the self-replay accuracy
//      metric), how many deviate >5%, and how many are catastrophic (>50%) - with a full list of
//      every deviating item (historical rate, recommended rate, % deviation), same format as the
//      manual reports done by hand earlier in this project's history.
//   5. Cleans up its own test RFQs afterward (identified by a distinctive fileName marker), so
//      repeated runs never accumulate garbage in the real RFQ store.
//
// Usage:
//   node test_historical_replay.cjs                          - run every historical project
//   node test_historical_replay.cjs "KOHLER PUNE FS 16TH JUNE" - run just the named project
//   node test_historical_replay.cjs --keep                    - don't delete test RFQs afterward
//   node test_historical_replay.cjs --out=results.json        - also write full JSON results
//
// Also runnable as: npm run test:replay-all
//
// Exit code: 0 always - this is a reporting tool, not a pass/fail gate by itself. The numbers it
// prints are what to compare run-over-run (e.g. before/after a fix) - see
// docs/audit/0002-identity-and-evidence-integrity-audit.md for the standing baseline.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ExcelJS = require("exceljs");

const BASE_URL = process.env.REPLAY_TEST_BASE_URL || "http://localhost:3000";
const FILENAME_MARKER_PREFIX = "SELFREPLAYTEST_";
const WITHIN_PERCENT = 1;
const DEVIATING_PERCENT = 5;
const CATASTROPHIC_PERCENT = 50;

const rawArgs = process.argv.slice(2);
const KEEP_TEST_RFQS = rawArgs.includes("--keep");
const OUT_ARG = rawArgs.find((a) => a.startsWith("--out="));
const OUT_FILE = OUT_ARG ? OUT_ARG.slice("--out=".length) : null;
const PROJECT_FILTER = rawArgs.find((a) => !a.startsWith("--"));

async function waitForServer(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/api/rfqs`);
      if (res.ok) return true;
    } catch (_) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function ensureServer() {
  const alreadyUp = await waitForServer(1000);
  if (alreadyUp) {
    console.log(`[harness] Using already-running server at ${BASE_URL}.`);
    return { proc: null };
  }
  console.log(`[harness] No server detected at ${BASE_URL} - starting one (npx tsx server.ts)...`);
  const proc = spawn("npx", ["tsx", "server.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: true
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  const up = await waitForServer(30000);
  if (!up) {
    console.error("[harness] Server did not come up within 30s. Aborting.");
    process.exit(1);
  }
  console.log("[harness] Server is up.");
  return { proc };
}

// Sanitize a worksheet name to Excel's rules (<=31 chars, no : \ / ? * [ ]) and de-duplicate.
function sanitizeSheetName(name, seen) {
  let s = String(name || "Sheet").replace(/[:\\/?*[\]]/g, "-").slice(0, 31).trim() || "Sheet";
  let unique = s;
  let n = 2;
  while (seen.has(unique)) {
    const suffix = ` (${n++})`;
    unique = s.slice(0, 31 - suffix.length) + suffix;
  }
  seen.add(unique);
  return unique;
}

// Builds an in-memory workbook directly from ground-truth mapping rows. Returns the base64
// bytes, an equivalent `sheets` fallback array (same shape the client normally sends), and a
// rowMap keyed "sheetName||rowNum" -> the originating mapping, so results can be joined back
// exactly (no description-matching ambiguity - this script controls the layout).
async function buildWorkbookFromMappings(mappings) {
  const wb = new ExcelJS.Workbook();
  const bySheet = new Map();
  for (const m of mappings) {
    const key = m.worksheetName || "Sheet1";
    if (!bySheet.has(key)) bySheet.set(key, []);
    bySheet.get(key).push(m);
  }

  const seenNames = new Set();
  const rowMap = new Map();
  const sheetsFallback = [];

  for (const [rawSheetName, rows] of bySheet.entries()) {
    const sheetName = sanitizeSheetName(rawSheetName, seenNames);
    const ws = wb.addWorksheet(sheetName);
    const header = ["SL NO", "ITEM DESCRIPTION", "UNIT", "QUANTITY", "RATE", "AMOUNT"];
    ws.addRow(header);
    const fallbackRows = [header];

    const sorted = [...rows].sort((a, b) => (a.rowNumber || 0) - (b.rowNumber || 0));
    sorted.forEach((m, idx) => {
      const excelRow = idx + 2; // row 1 is the header
      const dataRow = [
        idx + 1,
        m.originalItemDescription || "",
        m.uom || "",
        Number.isFinite(m.originalQuantity) ? m.originalQuantity : "",
        Number.isFinite(m.originalUnitRate) ? m.originalUnitRate : "",
        Number.isFinite(m.originalAmount) ? m.originalAmount : ""
      ];
      ws.addRow(dataRow);
      fallbackRows.push(dataRow.map((v) => String(v)));
      rowMap.set(`${sheetName}||${excelRow}`, m);
    });

    sheetsFallback.push({ sheetName, rows: fallbackRows });
  }

  const buf = await wb.xlsx.writeBuffer();
  return { base64: Buffer.from(buf).toString("base64"), sheetsFallback, rowMap };
}

async function deleteExistingTestRfqs(histId) {
  const res = await fetch(`${BASE_URL}/api/rfqs`);
  const rfqs = await res.json();
  const marker = `${FILENAME_MARKER_PREFIX}${histId}.xlsx`;
  const stale = rfqs.filter((r) => r.fileName === marker);
  for (const r of stale) {
    await fetch(`${BASE_URL}/api/rfqs/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.id })
    });
  }
  return stale.length;
}

async function runProjectReplay(histBOQ) {
  const mappingsPath = path.join(process.cwd(), "historical_sheets_store", `mappings_${histBOQ.id}.json`);
  if (!fs.existsSync(mappingsPath)) {
    return { project: histBOQ.projectName, error: `Ground-truth mappings file missing: ${mappingsPath}` };
  }
  const mappings = JSON.parse(fs.readFileSync(mappingsPath, "utf-8"));

  const removed = await deleteExistingTestRfqs(histBOQ.id);
  if (removed > 0) console.log(`[${histBOQ.projectName}] Removed ${removed} stale test RFQ(s) from a previous run.`);

  const { base64, sheetsFallback, rowMap } = await buildWorkbookFromMappings(mappings);

  const uploadRes = await fetch(`${BASE_URL}/api/rfqs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectName: `Copy of ${histBOQ.projectName}`, // "Copy of " triggers knownHistoricalTwin
      fileName: `${FILENAME_MARKER_PREFIX}${histBOQ.id}.xlsx`,
      sheets: sheetsFallback,
      originalBase64: base64
    })
  });
  const uploadJson = await uploadRes.json();
  if (!uploadRes.ok || !uploadJson.rfq) {
    return { project: histBOQ.projectName, error: `Upload failed: ${JSON.stringify(uploadJson)}` };
  }
  const rfqId = uploadJson.rfq.id;
  console.log(`[${histBOQ.projectName}] Uploaded as ${rfqId} (${uploadJson.itemsCount} items).`);

  const recRes = await fetch(`${BASE_URL}/api/rfqs/${rfqId}/recommend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}) // empty body -> knownHistoricalTwin supplies the real profile
  });
  const recJson = await recRes.json();
  if (!recRes.ok || !recJson.success) {
    return { project: histBOQ.projectName, rfqId, error: `Recommend failed: ${JSON.stringify(recJson)}` };
  }

  const itemsRes = await fetch(`${BASE_URL}/api/rfqs/${rfqId}/items`);
  const items = await itemsRes.json();

  // Join every returned item back to its originating mapping by exact (sheetName, rowNum).
  let groundTruthTotal = 0;
  let manualPricingNoRate = 0;
  let autoPopulated = 0;
  let within1 = 0;
  let deviating = 0;
  let catastrophic = 0;
  const deviatingItems = [];
  let joinMisses = 0;

  for (const item of items) {
    const m = rowMap.get(`${item.sheetName}||${item.rowNum}`);
    if (!m) {
      joinMisses++;
      continue;
    }
    if (!Number.isFinite(m.originalUnitRate) || m.originalUnitRate <= 0) continue; // no usable ground truth for this row

    groundTruthTotal++;
    const recommended = item.overriddenRate || item.recommendedRate || 0;

    if (!recommended || recommended <= 0) {
      manualPricingNoRate++;
      continue;
    }

    autoPopulated++;
    const deviationPercent = (Math.abs(recommended - m.originalUnitRate) / m.originalUnitRate) * 100;
    if (deviationPercent <= WITHIN_PERCENT) within1++;
    if (deviationPercent > DEVIATING_PERCENT) {
      deviating++;
      if (deviationPercent > CATASTROPHIC_PERCENT) catastrophic++;
      deviatingItems.push({
        sheet: item.sheetName,
        row: item.rowNum,
        description: String(item.originalDescription || "").slice(0, 70),
        historicalRate: m.originalUnitRate,
        recommendedRate: recommended,
        deviationPercent: Math.round(deviationPercent * 10) / 10,
        approvalStatus: item.approvalStatus,
        provenance: (item.decision && item.decision.rateProvenance) || "n/a"
      });
    }
  }
  deviatingItems.sort((a, b) => b.deviationPercent - a.deviationPercent);

  if (!KEEP_TEST_RFQS) {
    await fetch(`${BASE_URL}/api/rfqs/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rfqId })
    });
  }

  return {
    project: histBOQ.projectName,
    histId: histBOQ.id,
    rfqId,
    totalItems: items.length,
    joinMisses,
    groundTruthTotal,
    manualPricingNoRate,
    autoPopulated,
    within1,
    deviating,
    catastrophic,
    deviatingItems
  };
}

function pct(n, d) {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
}

function printProjectReport(r) {
  console.log(`\n${"=".repeat(90)}`);
  console.log(`PROJECT: ${r.project}`);
  if (r.error) {
    console.log(`  ERROR: ${r.error}`);
    return;
  }
  console.log(`  RFQ: ${r.rfqId} | Total items: ${r.totalItems} | Join misses: ${r.joinMisses}`);
  console.log(`  Ground-truth-eligible items: ${r.groundTruthTotal}`);
  console.log(`    Manual Pricing / no rate:  ${r.manualPricingNoRate} (${pct(r.manualPricingNoRate, r.groundTruthTotal)})`);
  console.log(`    Auto-populated rate:       ${r.autoPopulated} (${pct(r.autoPopulated, r.groundTruthTotal)})`);
  console.log(`      within ${WITHIN_PERCENT}% (self-replay accuracy): ${r.within1} (${pct(r.within1, r.autoPopulated)} of auto-populated)`);
  console.log(`      deviating > ${DEVIATING_PERCENT}%:                ${r.deviating} (${pct(r.deviating, r.autoPopulated)} of auto-populated)`);
  console.log(`        of which catastrophic > ${CATASTROPHIC_PERCENT}%: ${r.catastrophic}`);
  if (r.deviatingItems.length > 0) {
    console.log(`  Deviating items (all ${r.deviatingItems.length}):`);
    for (const d of r.deviatingItems) {
      console.log(
        `    [${d.sheet} r${d.row}] "${d.description}" hist=Rs.${d.historicalRate} rec=Rs.${d.recommendedRate} ` +
          `(${d.deviationPercent}% off) [${d.approvalStatus}] via ${d.provenance}`
      );
    }
  }
}

async function main() {
  const allHistoricalBOQs = require("./historical_boqs_store.json");
  const historicalBOQs = PROJECT_FILTER
    ? allHistoricalBOQs.filter((h) => h.projectName.toLowerCase().includes(PROJECT_FILTER.toLowerCase()))
    : allHistoricalBOQs;
  if (historicalBOQs.length === 0) {
    console.error(`No historical project matches "${PROJECT_FILTER}".`);
    process.exit(1);
  }
  console.log(`[harness] Running self-replay against ${historicalBOQs.length} historical project(s).`);

  const { proc } = await ensureServer();

  const results = [];
  for (const h of historicalBOQs) {
    try {
      const r = await runProjectReplay(h);
      results.push(r);
      printProjectReport(r);
    } catch (err) {
      const r = { project: h.projectName, error: `Exception: ${err.message}` };
      results.push(r);
      printProjectReport(r);
    }
  }

  // Combined totals across every project.
  const ok = results.filter((r) => !r.error);
  const sum = (field) => ok.reduce((acc, r) => acc + r[field], 0);
  const totalGT = sum("groundTruthTotal");
  const totalManual = sum("manualPricingNoRate");
  const totalAuto = sum("autoPopulated");
  const totalWithin1 = sum("within1");
  const totalDeviating = sum("deviating");
  const totalCatastrophic = sum("catastrophic");

  console.log(`\n${"#".repeat(90)}`);
  console.log(`COMBINED ACROSS ${ok.length}/${results.length} PROJECT(S) RUN SUCCESSFULLY`);
  console.log(`${"#".repeat(90)}`);
  console.log(`  Ground-truth-eligible items: ${totalGT}`);
  console.log(`    Manual Pricing / no rate:  ${totalManual} (${pct(totalManual, totalGT)})`);
  console.log(`    Auto-populated rate:       ${totalAuto} (${pct(totalAuto, totalGT)})`);
  console.log(`      within ${WITHIN_PERCENT}% (self-replay accuracy): ${totalWithin1} (${pct(totalWithin1, totalAuto)} of auto-populated)`);
  console.log(`      deviating > ${DEVIATING_PERCENT}%:                ${totalDeviating} (${pct(totalDeviating, totalAuto)} of auto-populated)`);
  console.log(`        of which catastrophic > ${CATASTROPHIC_PERCENT}%: ${totalCatastrophic}`);
  if (results.some((r) => r.error)) {
    console.log(`\n  Project(s) with errors: ${results.filter((r) => r.error).map((r) => r.project).join(", ")}`);
  }

  if (OUT_FILE) {
    fs.writeFileSync(
      OUT_FILE,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), results, combined: { totalGT, totalManual, totalAuto, totalWithin1, totalDeviating, totalCatastrophic } },
        null,
        2
      )
    );
    console.log(`\n[harness] Full results written to ${OUT_FILE}`);
  }

  if (proc) {
    console.log("[harness] Shutting down the server this script started.");
    proc.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
