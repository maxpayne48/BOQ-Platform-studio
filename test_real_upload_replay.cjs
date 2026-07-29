// REAL-BINARY replay suite (added 2026-07-29).
//
// Why this exists alongside test_historical_replay.cjs: that harness RECONSTRUCTS each project's
// workbook from its ground-truth mappings into a synthetic 6-column layout (SL NO / ITEM
// DESCRIPTION / UNIT / QUANTITY / RATE / AMOUNT). That means it can never exercise any defect
// rooted in real workbook STRUCTURE - multi-description-column layouts, split Supply/Erection rate
// headers, merged group headers, continuation rows. Exactly such a defect (the RFQ parser reading
// a short ALL-CAPS label column while historical ingestion read the full specification column,
// which collapsed two differently-priced counters into one identity) sat undetected behind a
// green 90.3% self-replay number for the entire audit.
//
// This suite instead uploads each project's ACTUAL retained .xlsx binary from uploads/ through the
// real POST /api/rfqs (originalBase64) + POST /api/rfqs/:id/recommend routes, joins results back
// to ground truth by exact (worksheetName, rowNumber) - the mappings' rowNumber IS the real file's
// Excel row - and additionally drives the real export route to verify Manual Pricing visibility.
//
// Usage:
//   node test_real_upload_replay.cjs                 - all mapped projects
//   node test_real_upload_replay.cjs COWRKS          - one project by name substring
//   node test_real_upload_replay.cjs --keep          - don't delete test RFQs afterward
//   node test_real_upload_replay.cjs --out=res.json  - write full JSON results
//   node test_real_upload_replay.cjs --no-export     - skip the export-verification step

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const BASE_URL = process.env.REPLAY_TEST_BASE_URL || "http://localhost:3000";
const MARKER = "REALBINARYTEST_";
const WITHIN_PERCENT = 1;
const DEVIATING_PERCENT = 5;
const CATASTROPHIC_PERCENT = 50;

const rawArgs = process.argv.slice(2);
const KEEP = rawArgs.includes("--keep");
const NO_EXPORT = rawArgs.includes("--no-export");
const OUT_ARG = rawArgs.find((a) => a.startsWith("--out="));
const OUT_FILE = OUT_ARG ? OUT_ARG.slice("--out=".length) : null;
const FILTER = rawArgs.find((a) => !a.startsWith("--"));

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Pairs each historical project with the retained uploaded binary that is genuinely the same
// workbook, decided by SHEET-NAME SIGNATURE (how many of that project's ground-truth worksheet
// names the candidate file actually contains) - never by filename, which is not reliable here.
function mapBinariesToProjects(historicalBOQs) {
  const signatures = [];
  for (const h of historicalBOQs) {
    const p = path.join(process.cwd(), "historical_sheets_store", `mappings_${h.id}.json`);
    if (!fs.existsSync(p)) continue;
    const mappings = JSON.parse(fs.readFileSync(p, "utf-8"));
    signatures.push({ boq: h, mappings, sheets: new Set(mappings.map((m) => m.worksheetName)) });
  }

  const uploadsDir = path.join(process.cwd(), "uploads");
  const candidates = fs.existsSync(uploadsDir)
    ? fs.readdirSync(uploadsDir).filter((f) => f.endsWith(".xlsx")).map((f) => ({ file: path.join(uploadsDir, f), size: fs.statSync(path.join(uploadsDir, f)).size }))
    : [];

  const pairs = [];
  for (const sig of signatures) {
    let best = null;
    for (const c of candidates) {
      if (c.size < 500000) continue; // harness-generated synthetic workbooks, not real uploads
      let names;
      try {
        const wbXml = new AdmZip(c.file).readAsText("xl/workbook.xml");
        names = [...wbXml.matchAll(/<sheet\s[^>]*name="([^"]+)"/g)].map((m) => decodeEntities(m[1]));
      } catch { continue; }
      const matched = names.filter((n) => sig.sheets.has(n)).length;
      if (matched === sig.sheets.size && (!best || c.size > best.size)) best = { ...c, matched };
    }
    if (best) pairs.push({ ...sig, binary: best.file, binarySize: best.size });
    else pairs.push({ ...sig, binary: null });
  }
  return pairs;
}

async function deleteTestRfqs() {
  const rfqs = await (await fetch(`${BASE_URL}/api/rfqs`)).json();
  let n = 0;
  for (const r of rfqs.filter((r) => String(r.fileName || "").startsWith(MARKER))) {
    await fetch(`${BASE_URL}/api/rfqs/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id })
    });
    n++;
  }
  return n;
}

async function runProject(pair) {
  const name = pair.boq.projectName;
  if (!pair.binary) return { project: name, error: "No retained real .xlsx binary in uploads/ matches this project's worksheet signature" };

  const buf = fs.readFileSync(pair.binary);
  // `sheets` is required by the upload route but is only consumed by the LEGACY fallback parser
  // (reached only if the real workbook fails to load); originalBase64 is what the real universal
  // parser reads. A stub keeps the harness from re-parsing a 78MB workbook client-side.
  const upload = await fetch(`${BASE_URL}/api/rfqs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectName: `Copy of ${name}`, // "Copy of " lets the server's twin detection supply the real profile
      fileName: `${MARKER}${pair.boq.id}.xlsx`,
      sheets: [{ sheetName: "stub", rows: [["stub"]] }],
      originalBase64: buf.toString("base64")
    })
  });
  const upJson = await upload.json();
  if (!upJson.rfq) return { project: name, error: `Upload failed: ${JSON.stringify(upJson).slice(0, 300)}` };
  const rfqId = upJson.rfq.id;

  const rec = await fetch(`${BASE_URL}/api/rfqs/${rfqId}/recommend`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
  });
  const recJson = await rec.json();
  if (!recJson.success) return { project: name, rfqId, error: `Recommend failed: ${JSON.stringify(recJson).slice(0, 300)}` };

  const items = await (await fetch(`${BASE_URL}/api/rfqs/${rfqId}/items`)).json();
  const byKey = new Map();
  for (const it of items) byKey.set(`${it.sheetName}||${it.rowNum}`, it);

  let groundTruthTotal = 0, notParsed = 0, manualPricing = 0, autoPopulated = 0;
  let within1 = 0, deviating = 0, catastrophic = 0;
  const deviatingItems = [];

  for (const m of pair.mappings) {
    if (!Number.isFinite(m.originalUnitRate) || m.originalUnitRate <= 0) continue;
    groundTruthTotal++;
    const it = byKey.get(`${m.worksheetName}||${m.rowNumber}`);
    if (!it) { notParsed++; continue; }
    const rate = it.overriddenRate || it.recommendedRate || 0;
    if (!rate || rate <= 0) { manualPricing++; continue; }
    autoPopulated++;
    const dev = (Math.abs(rate - m.originalUnitRate) / m.originalUnitRate) * 100;
    if (dev <= WITHIN_PERCENT) within1++;
    if (dev > DEVIATING_PERCENT) {
      deviating++;
      if (dev > CATASTROPHIC_PERCENT) catastrophic++;
      deviatingItems.push({
        sheet: m.worksheetName, row: m.rowNumber,
        description: String(it.originalDescription || "").replace(/\s+/g, " ").slice(0, 70),
        historicalRate: m.originalUnitRate, recommendedRate: rate,
        deviationPercent: Math.round(dev * 10) / 10,
        approvalStatus: it.approvalStatus,
        provenance: (it.decision && it.decision.rateProvenance) || "n/a"
      });
    }
  }
  deviatingItems.sort((a, b) => b.deviationPercent - a.deviationPercent);

  // Repeated-constant fingerprint scan (Section 5.4 of the deployment brief): any single rate
  // shared by many unrelated items is the signature of an identity collapse.
  const rateCounts = new Map();
  for (const it of items) {
    const r = it.recommendedRate;
    if (r > 0) rateCounts.set(r, (rateCounts.get(r) || 0) + 1);
  }
  const repeatedConstants = [...rateCounts.entries()]
    .filter(([, n]) => n >= 8).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([rate, count]) => ({ rate, count }));

  // Export verification - the JSON-only path above never exercises cell writing, Manual Pricing
  // flag placement, or installation-rate clearing.
  let exportCheck = null;
  if (!NO_EXPORT) {
    try {
      const exp = await fetch(`${BASE_URL}/api/rfqs/${rfqId}/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const expJson = await exp.json();
      if (expJson.base64) {
        const outBuf = Buffer.from(expJson.base64, "base64");
        const zip = new AdmZip(outBuf);
        let flagCells = 0, sheetsWithFlag = 0;
        for (const e of zip.getEntries()) {
          if (!/xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName)) continue;
          const xml = zip.readAsText(e);
          const n = (xml.match(/MANUAL PRICING REQUIRED/g) || []).length;
          if (n > 0) { flagCells += n; sheetsWithFlag++; }
        }
        const expectedFlags = items.filter((i) => i.approvalStatus === "Manual Pricing" && !i.isOverridden).length;
        exportCheck = { bytes: outBuf.length, expectedManualPricingItems: expectedFlags, flagCellsWritten: flagCells, sheetsWithFlag, allFlagged: flagCells >= expectedFlags };
      } else {
        exportCheck = { error: String(expJson.error || JSON.stringify(expJson).slice(0, 200)) };
      }
    } catch (err) {
      exportCheck = { error: err.message };
    }
  }

  if (!KEEP) {
    await fetch(`${BASE_URL}/api/rfqs/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: rfqId }) });
  }

  return {
    project: name, histId: pair.boq.id, rfqId,
    binary: path.basename(pair.binary), binarySize: pair.binarySize,
    itemsParsed: items.length,
    groundTruthTotal, notParsed, manualPricing, autoPopulated,
    within1, deviating, catastrophic, deviatingItems, repeatedConstants, exportCheck
  };
}

function pct(n, d) { return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "n/a"; }

function printReport(r, verbose) {
  console.log(`\n${"=".repeat(92)}`);
  console.log(`PROJECT: ${r.project}`);
  if (r.error) { console.log(`  ERROR: ${r.error}`); return; }
  console.log(`  Binary: ${r.binary} (${(r.binarySize / 1048576).toFixed(1)} MB) | RFQ ${r.rfqId} | items parsed: ${r.itemsParsed}`);
  console.log(`  Ground-truth-eligible rows: ${r.groundTruthTotal}`);
  console.log(`    Not parsed at all:        ${r.notParsed} (${pct(r.notParsed, r.groundTruthTotal)})`);
  console.log(`    Manual Pricing / no rate: ${r.manualPricing} (${pct(r.manualPricing, r.groundTruthTotal)})`);
  console.log(`    Auto-populated rate:      ${r.autoPopulated} (${pct(r.autoPopulated, r.groundTruthTotal)})`);
  console.log(`      within ${WITHIN_PERCENT}%:        ${r.within1} (${pct(r.within1, r.autoPopulated)} of auto-populated)`);
  console.log(`      deviating > ${DEVIATING_PERCENT}%:     ${r.deviating} (${pct(r.deviating, r.autoPopulated)})`);
  console.log(`        catastrophic > ${CATASTROPHIC_PERCENT}%: ${r.catastrophic}`);
  if (r.repeatedConstants.length) {
    console.log(`  Rates shared by >=8 items (identity-collapse fingerprint):`);
    for (const c of r.repeatedConstants) console.log(`      Rs.${c.rate} x ${c.count}`);
  } else {
    console.log(`  Rates shared by >=8 items: none`);
  }
  if (r.exportCheck) {
    const e = r.exportCheck;
    if (e.error) console.log(`  EXPORT: FAILED - ${e.error}`);
    else console.log(`  EXPORT: ${(e.bytes / 1048576).toFixed(1)} MB | Manual Pricing items ${e.expectedManualPricingItems} -> flag cells written ${e.flagCellsWritten} across ${e.sheetsWithFlag} sheet(s) ${e.allFlagged ? "[OK]" : "[MISSING FLAGS]"}`);
  }
  if (verbose && r.deviatingItems.length) {
    console.log(`  Deviating items (top 25 of ${r.deviatingItems.length}):`);
    for (const d of r.deviatingItems.slice(0, 25)) {
      console.log(`    [${d.sheet} r${d.row}] "${d.description}" hist=Rs.${d.historicalRate} rec=Rs.${d.recommendedRate} (${d.deviationPercent}%) [${d.approvalStatus}] via ${d.provenance}`);
    }
  }
}

async function main() {
  const historicalBOQs = require("./historical_boqs_store.json");
  let pairs = mapBinariesToProjects(historicalBOQs);
  if (FILTER) pairs = pairs.filter((p) => p.boq.projectName.toLowerCase().includes(FILTER.toLowerCase()));
  if (!pairs.length) { console.error(`No project matches "${FILTER}".`); process.exit(1); }

  const removed = await deleteTestRfqs();
  if (removed) console.log(`[harness] Removed ${removed} stale test RFQ(s).`);
  console.log(`[harness] Real-binary replay across ${pairs.length} project(s).`);

  const results = [];
  for (const p of pairs) {
    try { const r = await runProject(p); results.push(r); printReport(r, true); }
    catch (err) { const r = { project: p.boq.projectName, error: `Exception: ${err.message}` }; results.push(r); printReport(r, true); }
  }

  const ok = results.filter((r) => !r.error);
  const sum = (f) => ok.reduce((a, r) => a + (r[f] || 0), 0);
  console.log(`\n${"#".repeat(92)}`);
  console.log(`COMBINED (REAL BINARIES) ACROSS ${ok.length}/${results.length} PROJECT(S)`);
  console.log(`${"#".repeat(92)}`);
  const gt = sum("groundTruthTotal"), auto = sum("autoPopulated");
  console.log(`  Ground-truth-eligible rows: ${gt}`);
  console.log(`    Not parsed:               ${sum("notParsed")} (${pct(sum("notParsed"), gt)})`);
  console.log(`    Manual Pricing / no rate: ${sum("manualPricing")} (${pct(sum("manualPricing"), gt)})`);
  console.log(`    Auto-populated:           ${auto} (${pct(auto, gt)})`);
  console.log(`      within ${WITHIN_PERCENT}%:    ${sum("within1")} (${pct(sum("within1"), auto)} of auto-populated)`);
  console.log(`      deviating > ${DEVIATING_PERCENT}%: ${sum("deviating")} (${pct(sum("deviating"), auto)})`);
  console.log(`        catastrophic: ${sum("catastrophic")}`);

  if (OUT_FILE) {
    fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
    console.log(`\n[harness] Full results written to ${OUT_FILE}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
