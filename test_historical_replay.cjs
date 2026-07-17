const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

// Import databases
const rfqsStore = require('./rfqs_store.json');
const rfqItemsStore = require('./rfq_items_store.json');
const masterBOQItems = require('./master_boq_store.json');
const historicalBOQs = require('./historical_boqs_store.json');

const rfqId = 'rfq_3bvg0xfx4';
const rfq = rfqsStore.find(r => r.id === rfqId);
const items = rfqItemsStore.filter(i => i.rfqId === rfqId);

// Get historical mappings
const matchedProj = rfq.matchedProjectName;
const histBOQ = historicalBOQs.find(h => h.projectName === matchedProj);
const histProjectId = histBOQ ? histBOQ.id : "N/A";

console.log('RFQ:', rfq.projectName);
console.log('Matched Project:', matchedProj);
console.log('Historical Project ID:', histProjectId);

// Reconstruct getHistoricalRowMappings fallback logic
function getHistoricalRowMappings(projectId, projectName) {
  const mappingsPath = path.join(process.cwd(), "historical_sheets_store", `mappings_${projectId}.json`);
  if (fs.existsSync(mappingsPath)) {
    return JSON.parse(fs.readFileSync(mappingsPath, "utf-8"));
  }

  // Fallback: Reconstruct dynamically
  const projectItems = masterBOQItems.filter(m => m.projects && m.projects.includes(projectName));
  const mappings = [];
  
  for (const m of projectItems) {
    const idx = m.projects.indexOf(projectName);
    if (idx !== -1) {
      const sheetName = m.historicalWorksheets?.[idx];
      const rowNum = m.historicalRows?.[idx];
      const rate = m.historicalRates?.[idx];
      const cell = m.historicalCells?.[idx] || "N/A";
      const desc = m.historicalDescriptions?.[idx] || m.standardDescription;
      
      if (sheetName && rowNum) {
        mappings.push({
          worksheetName: sheetName,
          rowNumber: rowNum,
          unitRateCellAddress: cell,
          amountCellAddress: cell.replace('G', 'H').replace('E', 'F'), // approximate
          originalUnitRate: rate,
          originalItemDescription: desc,
          masterItemId: m.id
        });
      }
    }
  }
  return mappings;
}

const mappings = getHistoricalRowMappings(histProjectId, matchedProj);
console.log('Mappings count:', mappings.length);

async function runTest() {
  const filePath = path.join(process.cwd(), 'uploads', `${rfqId}.xlsx`);
  const originalBuffer = fs.readFileSync(filePath);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(originalBuffer);

  const blueprint = rfq.workbookBlueprint;
  const activeItems = items.filter(i => i.status === 'Accepted' || i.status === 'Needs Manual Review');

  // Load patched/exported workbook
  // Let's call the server export or build the export buffer ourselves using server's logic
  const zip = await JSZip.loadAsync(originalBuffer);
  const workbookXmlFile = zip.file("xl/workbook.xml");
  const workbookRelsXmlFile = zip.file("xl/_rels/workbook.xml.rels");
  const workbookXml = await workbookXmlFile.async("string");
  const workbookRelsXml = await workbookRelsXmlFile.async("string");

  const rels = {};
  const relRegex = /<Relationship\s+[^>]*?Id="([^"]+)"\s+[^>]*?Target="([^"]+)"/ig;
  let relMatch;
  while ((relMatch = relRegex.exec(workbookRelsXml)) !== null) {
    rels[relMatch[1]] = relMatch[2];
  }

  const xmlPaths = {};
  const sheetRegex = /<sheet\s+[^>]*?name="([^"]+)"\s+[^>]*?r:id="([^"]+)"/ig;
  let sheetMatch;
  while ((sheetMatch = sheetRegex.exec(workbookXml)) !== null) {
    const sName = decodeXmlEntities(sheetMatch[1]);
    const rId = sheetMatch[2];
    const target = rels[rId];
    if (target) {
      xmlPaths[sName] = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    }
  }

  function decodeXmlEntities(str) {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  function getCellRef(row, col) {
    let colName = "";
    let temp = col;
    while (temp > 0) {
      let rem = (temp - 1) % 26;
      colName = String.fromCharCode(65 + rem) + colName;
      temp = Math.floor((temp - 1) / 26);
    }
    return `${colName}${row}`;
  }

  function updateCellInXml(xml, cellRef, newValue) {
    const escapedCellRef = cellRef.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const selfClosingRegex = new RegExp("<c\\s+([^>]*?\\br=['\"]" + escapedCellRef + "['\"][^>]*?)\\/\\>", "i");
    const selfMatch = xml.match(selfClosingRegex);
    if (selfMatch) {
      const fullMatchStr = selfMatch[0];
      const attrs = selfMatch[1];
      const cleanAttrs = attrs.replace(/\bt=['"](?:s|str)['"]\s*/g, "").trim();
      const replacement = `<c ${cleanAttrs}><v>${newValue}</v></c>`;
      return xml.replace(fullMatchStr, replacement);
    }
    const fullCellRegex = new RegExp("<c\\s+([^>]*?\\br=['\"]" + escapedCellRef + "['\"][^>]*?)>((?:(?!<c\\b).)*?)<\\/c>", "is");
    const fullMatch = xml.match(fullCellRegex);
    if (fullMatch) {
      const fullMatchStr = fullMatch[0];
      const attrs = fullMatch[1];
      let innerContent = fullMatch[2];
      const cleanAttrs = attrs.replace(/\bt=['"](?:s|str)['"]\s*/g, "").trim();
      const newOpenTag = `<c ${cleanAttrs}>`;
      if (/<v\b[^>]*>.*?<\/v>/i.test(innerContent)) {
        innerContent = innerContent.replace(/<v\b[^>]*>.*?<\/v>/i, `<v>${newValue}</v>`);
      } else {
        innerContent = innerContent + `<v>${newValue}</v>`;
      }
      const replacement = `${newOpenTag}${innerContent}</c>`;
      return xml.replace(fullMatchStr, replacement);
    }
    return xml;
  }

  const itemsBySheet = {};
  activeItems.forEach(item => {
    if (!itemsBySheet[item.sheetName]) {
      itemsBySheet[item.sheetName] = [];
    }
    itemsBySheet[item.sheetName].push(item);
  });

  for (const [sheetName, sheetItems] of Object.entries(itemsBySheet)) {
    const xmlPath = xmlPaths[sheetName];
    if (!xmlPath) continue;
    const sheetBlue = blueprint.sheets[sheetName];
    if (!sheetBlue) continue;
    const zipFile = zip.file(xmlPath);
    if (!zipFile) continue;

    let xml = await zipFile.async("string");
    sheetItems.forEach(item => {
      const rateToInject = item.overriddenRate || item.recommendedRate;
      const rateCellRef = getCellRef(item.rowNum, sheetBlue.rateCellColumn);
      xml = updateCellInXml(xml, rateCellRef, rateToInject);

      if (sheetBlue.amountCellColumn !== -1 && sheetBlue.amountCellColumn !== sheetBlue.rateCellColumn) {
        const amtCellRef = getCellRef(item.rowNum, sheetBlue.amountCellColumn);
        const amtVal = item.quantity * rateToInject;
        xml = updateCellInXml(xml, amtCellRef, amtVal);
      }
    });
    zip.file(xmlPath, xml);
  }

  const outputBuffer = await zip.generateAsync({ type: "nodebuffer" });

  const patchedWorkbook = new ExcelJS.Workbook();
  await patchedWorkbook.xlsx.load(outputBuffer);

  // Let's compare patched rate and amount cells against historical baseline
  console.log('\n--- Comparing Patched Rates and Amounts against Historical Baseline Mappings ---');
  let matchedCount = 0;
  let totalCompared = 0;
  const replayItems = [];

  mappings.forEach(cell => {
    const genSheet = patchedWorkbook.getWorksheet(cell.worksheetName);
    let exportedRate = 0;
    let exportedAmount = 0;
    let cellFound = false;

    if (genSheet) {
      const cellInGen = genSheet.getCell(cell.unitRateCellAddress);
      if (cellInGen && cellInGen.value !== null && cellInGen.value !== undefined) {
        cellFound = true;
        const val = cellInGen.value;
        if (val && typeof val === "object" && "result" in val) {
          exportedRate = Number(val.result || 0);
        } else if (val && typeof val === "object" && "formula" in val) {
          exportedRate = Number(val.result || 0);
        } else {
          exportedRate = Number(val || 0);
        }
      }

      // Read amount
      const amtCellInGen = genSheet.getCell(cell.amountCellAddress || cell.unitRateCellAddress.replace('G', 'H'));
      if (amtCellInGen && amtCellInGen.value !== null && amtCellInGen.value !== undefined) {
        const val = amtCellInGen.value;
        if (val && typeof val === "object" && "result" in val) {
          exportedAmount = Number(val.result || 0);
        } else if (val && typeof val === "object" && "formula" in val) {
          exportedAmount = Number(val.result || 0);
        } else {
          exportedAmount = Number(val || 0);
        }
      }
    }

    const originalRate = cell.originalUnitRate;
    const difference = exportedRate - originalRate;
    const exactMatch = Math.abs(difference) < 0.01;

    totalCompared++;
    if (exactMatch) {
      matchedCount++;
    } else {
      replayItems.push({
        worksheetName: cell.worksheetName,
        cellAddress: cell.unitRateCellAddress,
        originalValue: originalRate,
        exportedValue: exportedRate,
        reason: `Unit Rate difference. Baseline has ₹${originalRate}, Export has ₹${exportedRate}`
      });
    }
  });

  console.log(`Replay Accuracy: ${matchedCount} / ${totalCompared} (${(matchedCount/totalCompared*100).toFixed(2)}%)`);
  console.log(`Mismatching cells count: ${replayItems.length}`);
  console.log(`Mismatch details:`, replayItems.slice(0, 10));
}

runTest().catch(console.error);
