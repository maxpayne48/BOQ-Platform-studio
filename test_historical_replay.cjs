// Self-replay regression harness (Audit 0002).
//
// Measures how faithfully the recommendation engine reproduces a historical BOQ's own
// commercial rates when that BOQ is re-uploaded as an unrated RFQ. There is no replay
// mode in the engine - this is purely a validation metric: for every RFQ item that has
// an exact ground-truth counterpart in the historical project's row mappings, compare
// the engine's recommended rate against the original historical unit rate and count
// deviations > 5%.
//
// Usage:  node test_historical_replay.cjs [rfqId] [historicalProjectName]
// Defaults: the first RFQ in rfqs_store.json, matched against the historical project
// whose normalized name matches the RFQ's (strips "copy of", punctuation, whitespace).

const fs = require("fs");
const path = require("path");

const rfqsStore = require("./rfqs_store.json");
const rfqItemsStore = require("./rfq_items_store.json");
const historicalBOQs = require("./historical_boqs_store.json");

const DEVIATION_THRESHOLD_PERCENT = 5;

function normalizeProjectName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\.(xlsx|xls|csv)$/i, "")
    .replace(/\bcopy of\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const rfqId = process.argv[2] || (rfqsStore[0] && rfqsStore[0].id);
const rfq = rfqsStore.find((r) => r.id === rfqId);
if (!rfq) {
  console.error(`RFQ "${rfqId}" not found in rfqs_store.json`);
  process.exit(1);
}

const wantedHistName = process.argv[3];
const rfqNorm = normalizeProjectName(rfq.projectName || rfq.fileName);
const histBOQ = wantedHistName
  ? historicalBOQs.find((h) => h.projectName === wantedHistName)
  : historicalBOQs.find((h) => normalizeProjectName(h.projectName) === rfqNorm);
if (!histBOQ) {
  console.error(`No historical project matches RFQ "${rfq.projectName}" (normalized: "${rfqNorm}")`);
  process.exit(1);
}

const mappingsPath = path.join(process.cwd(), "historical_sheets_store", `mappings_${histBOQ.id}.json`);
if (!fs.existsSync(mappingsPath)) {
  console.error(`Ground-truth mappings file missing: ${mappingsPath}`);
  process.exit(1);
}
const mappings = JSON.parse(fs.readFileSync(mappingsPath, "utf-8"));

const items = rfqItemsStore.filter((i) => i.rfqId === rfqId);

console.log(`RFQ: ${rfq.projectName} (${rfqId}) - ${items.length} items`);
console.log(`Historical ground truth: ${histBOQ.projectName} (${histBOQ.id}) - ${mappings.length} mapped rows`);

// Ground-truth join: primary key (worksheetName, rowNumber) - the RFQ is a byte-copy of
// the same workbook, so sheet+row is exact. Fallback: exact normalized description match
// (only when unambiguous - a description appearing exactly once in the mappings).
const bySheetRow = new Map();
for (const m of mappings) {
  bySheetRow.set(`${m.worksheetName} ${m.rowNumber}`, m);
}
const descCount = new Map();
const byDesc = new Map();
for (const m of mappings) {
  const d = String(m.originalItemDescription || "").trim().toLowerCase();
  descCount.set(d, (descCount.get(d) || 0) + 1);
  byDesc.set(d, m);
}

let matched = 0;
let within5 = 0;
const deviations = [];
let unmatched = 0;

for (const item of items) {
  let m = bySheetRow.get(`${item.sheetName} ${item.rowNum}`);
  if (!m) {
    const d = String(item.originalDescription || "").trim().toLowerCase();
    if (descCount.get(d) === 1) m = byDesc.get(d);
  }
  if (!m || !Number.isFinite(m.originalUnitRate) || m.originalUnitRate <= 0) {
    unmatched++;
    continue;
  }

  matched++;
  const recommended = item.overriddenRate || item.recommendedRate || 0;
  const deviationPercent = (Math.abs(recommended - m.originalUnitRate) / m.originalUnitRate) * 100;
  if (deviationPercent <= DEVIATION_THRESHOLD_PERCENT) {
    within5++;
  } else {
    deviations.push({
      sheet: item.sheetName,
      row: item.rowNum,
      description: String(item.originalDescription).slice(0, 60),
      historicalRate: m.originalUnitRate,
      recommendedRate: recommended,
      deviationPercent: Math.round(deviationPercent * 10) / 10,
      approvalStatus: item.approvalStatus,
      provenance: (item.decision && item.decision.rateProvenance) || "n/a"
    });
  }
}

deviations.sort((a, b) => b.deviationPercent - a.deviationPercent);

console.log(`\nMatched to ground truth: ${matched} (unmatched/no-rate: ${unmatched})`);
console.log(`Within +-${DEVIATION_THRESHOLD_PERCENT}%: ${within5} (${((within5 / matched) * 100).toFixed(1)}%)`);
console.log(`DEVIATING > ${DEVIATION_THRESHOLD_PERCENT}%: ${deviations.length} (${((deviations.length / matched) * 100).toFixed(1)}%)`);

const catastrophic = deviations.filter((d) => d.deviationPercent > 90);
console.log(`  of which catastrophic (>90% off): ${catastrophic.length}`);

console.log(`\nWorst 15 deviations:`);
for (const d of deviations.slice(0, 15)) {
  console.log(
    `  [${d.sheet} r${d.row}] "${d.description}" hist=Rs.${d.historicalRate} rec=Rs.${d.recommendedRate} ` +
      `(${d.deviationPercent}% off) [${d.approvalStatus}] via ${d.provenance}`
  );
}

// Provenance breakdown of deviating items - which pipeline stage produced the bad rates.
const byProv = {};
for (const d of deviations) byProv[d.provenance] = (byProv[d.provenance] || 0) + 1;
console.log(`\nDeviating items by rate provenance:`, byProv);
