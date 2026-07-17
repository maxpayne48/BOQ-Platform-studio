import { Domain, HistoricalBOQ, MasterBOQItem, RFQItem } from "./types.js";

export interface ProjectSimilarityInput {
  projectCost: number;
  projectSize: number;
  projectType: string;
  city: string;
  buildingGrade: string;
}

export interface ReplayRecord {
  projectUuid: string;
  worksheetUuid?: string;
  worksheetName?: string;
  excelRowNumber?: number;
  excelColumnNumber?: number;
  originalDescription: string;
  quantity: number;
  uom: string;
  unitRate: number;
  amount: number;
  rateCellAddress?: string;
  amountCellAddress?: string;
  quantityCellAddress?: string;
  workbookHash?: string;
  worksheetHash?: string;
  rowHash?: string;
  masterItemId?: string;
}

export const RecommendationEngineV2 = {
  // STEP 2: Retrieve the Top 5 similar historical projects
  getSimilarProjects(
    historicalBOQs: HistoricalBOQ[],
    input: ProjectSimilarityInput
  ): { project: HistoricalBOQ; similarity: number }[] {
    const scored = historicalBOQs.map(h => {
      // 1. Project Type Match (Weight: 20%)
      const hType = (h.projectType || "Commercial Office").toLowerCase().trim();
      const inputType = input.projectType.toLowerCase().trim();
      const typeSimilarity = hType === inputType ? 1.0 : (hType.includes(inputType) || inputType.includes(hType) ? 0.6 : 0.0);

      // 2. Project Cost Match (Weight: 25%)
      const hCost = h.projectCost ? parseFloat(String(h.projectCost).replace(/[^0-9.]/g, "")) : 15000000;
      const costDiff = Math.abs(input.projectCost - hCost);
      const costSimilarity = input.projectCost > 0 ? Math.max(0, 1 - (costDiff / input.projectCost)) : 1.0;

      // 3. Project Size Match (Weight: 25%)
      const hSize = h.projectSize ? parseFloat(String(h.projectSize).replace(/[^0-9.]/g, "")) : 50000;
      const sizeDiff = Math.abs(input.projectSize - hSize);
      const sizeSimilarity = input.projectSize > 0 ? Math.max(0, 1 - (sizeDiff / input.projectSize)) : 1.0;

      // 4. City Match (Weight: 20%)
      const hLoc = (h.location || "").toLowerCase();
      const inputCity = input.city.toLowerCase().trim();
      const citySimilarity = hLoc.includes(inputCity) || inputCity.includes(hLoc) ? 1.0 : 0.0;

      // 5. Building Grade Match (Weight: 10%)
      const pGrade = (h.projectName + " " + (h.projectType || "")).toLowerCase();
      let projectGrade = "Grade A";
      if (pGrade.includes("grade a") || pGrade.includes("premium") || pGrade.includes("luxury")) {
        projectGrade = "Grade A";
      } else if (pGrade.includes("grade b") || pGrade.includes("standard")) {
        projectGrade = "Grade B";
      }
      const inputGrade = input.buildingGrade.toLowerCase().trim();
      const gradeSimilarity = projectGrade.includes(inputGrade) || inputGrade.includes(projectGrade) ? 1.0 : 0.5;

      const similarity = (typeSimilarity * 0.20) + (costSimilarity * 0.25) + (sizeSimilarity * 0.25) + (citySimilarity * 0.20) + (gradeSimilarity * 0.10);
      return { project: h, similarity };
    });

    return scored
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);
  },

  getAdjustmentsForDomain(domain: string) {
    const DOMAIN_ADJUSTMENTS: Record<string, { wastage: number; handling: number; installation: number; margin: number }> = {
      [Domain.Civil]: { wastage: 0.05, handling: 0.02, installation: 0.15, margin: 0.10 },
      [Domain.Interior]: { wastage: 0.08, handling: 0.03, installation: 0.20, margin: 0.15 },
      [Domain.Electrical]: { wastage: 0.03, handling: 0.015, installation: 0.12, margin: 0.12 },
      [Domain.Mechanical]: { wastage: 0.02, handling: 0.02, installation: 0.10, margin: 0.10 }
    };
    return DOMAIN_ADJUSTMENTS[domain] || DOMAIN_ADJUSTMENTS[Domain.Civil];
  },

  getLocationFactorForCity(city: string): number {
    if (!city) return 1.0;
    const c = city.toLowerCase();
    if (c.includes("delhi") || c.includes("ncr") || c.includes("gurgaon") || c.includes("gurugram") || c.includes("noida")) {
      return 1.0;
    }
    if (c.includes("mumbai") || c.includes("bkc") || c.includes("pune")) {
      return 1.12;
    }
    if (c.includes("bangalore") || c.includes("bengaluru")) {
      return 1.05;
    }
    if (c.includes("hyderabad")) {
      return 1.02;
    }
    if (c.includes("chennai")) {
      return 0.98;
    }
    if (c.includes("kolkata")) {
      return 0.95;
    }
    if (c.includes("jaipur")) {
      return 0.90;
    }
    if (c.includes("ahmedabad")) {
      return 0.92;
    }
    if (c.includes("chandigarh")) {
      return 1.00;
    }
    return 1.0;
  },

  recommendItem(
    item: RFQItem,
    top5Projects: HistoricalBOQ[],
    replayDatabase: ReplayRecord[],
    descriptionToMasterIdIndex: Record<string, string>,
    masterItemIdIndex: Record<string, MasterBOQItem>,
    city: string,
    uomConverter: (rfqUnit: string, targetUnit: string) => { factor: number; compatible: boolean; trace: string[] }
  ) {
    const locationFactor = this.getLocationFactorForCity(city);
    const top5Ids = new Set(top5Projects.map(p => p.id));
    const descKey = item.originalDescription.toLowerCase().trim();

    // A. SEARCH ONLY THOSE TOP 5 PROJECTS
    const top5Records = replayDatabase.filter(r => top5Ids.has(r.projectUuid));

    // STEP 4: If Historical Rate exists
    // 1. Direct exact description match
    let matchRecord = top5Records.find(r => r.originalDescription.toLowerCase().trim() === descKey);

    // 2. Index-based match
    if (!matchRecord) {
      const masterId = descriptionToMasterIdIndex[descKey];
      if (masterId) {
        matchRecord = top5Records.find(r => r.masterItemId === masterId);
      }
    }

    if (matchRecord) {
      const historicalRate = matchRecord.unitRate;
      const uomMatch = uomConverter(item.unit, matchRecord.uom);
      const uomFactor = uomMatch.factor;
      const finalRate = historicalRate * uomFactor * locationFactor;
      const confidence = 95;

      const matchedProj = top5Projects.find(p => p.id === matchRecord?.projectUuid);
      const projName = matchedProj ? matchedProj.projectName : "Similar Project";

      return {
        recommendedRate: Math.round(finalRate * 100) / 100,
        source: "Historical Rate" as const,
        worksheet: matchRecord.worksheetName || "Historical Worksheet",
        historicalItem: matchRecord.originalDescription,
        confidence,
        reason: `[Historical Rate] Sourced from matching item in Top 5 similar project "${projName}". Adjustments: UOM Factor: ${uomFactor.toFixed(2)}, Location Factor (City: ${city}): ${locationFactor.toFixed(2)}.`,
        matchedMasterId: matchRecord.masterItemId,
        trace: {
          rfqItem: item.originalDescription,
          historicalProject: projName,
          historicalProjectCost: matchedProj?.projectCost ? parseFloat(String(matchedProj.projectCost).replace(/[^0-9.]/g, "")) : 0,
          historicalProjectType: matchedProj?.projectType || "N/A",
          historicalWorksheet: matchRecord.worksheetName || "N/A",
          historicalCell: matchRecord.rateCellAddress || "N/A",
          historicalUnitRate: historicalRate,
          recommendedUnitRate: Math.round(finalRate * 100) / 100,
          replayMode: "Yes" as "Yes" | "No",
          matchType: "Top 5 Similar Project Match",
          rateSource: "Historical Rate",
          explanation: `[Historical Rate Recommendation Trace]
- Source Project: ${projName}
- Historical Item: ${matchRecord.originalDescription}
- Base Rate: ₹${historicalRate.toFixed(2)}
- UOM Conversion Factor: ${uomFactor.toFixed(2)}
- Location Factor: ${locationFactor.toFixed(2)} (City: ${city})
- Final Recommended Rate: ₹${(Math.round(finalRate * 100) / 100).toFixed(2)}`
        }
      };
    }

    // STEP 5: Else, calculate Basic Rate sequential adjustments
    const masterId = descriptionToMasterIdIndex[descKey];
    let basePrice = 1000;
    let standardUnit = item.unit;
    let baseSource = "Domain Baseline Fallback";
    let matchedMaster: MasterBOQItem | null = null;

    if (masterId) {
      const m = masterItemIdIndex[masterId];
      if (m) {
        matchedMaster = m;
        basePrice = m.basicRate || m.averageRate || m.medianRate || 1000;
        standardUnit = m.standardUnit || item.unit;
        baseSource = `Master Catalog Standard Item "${m.standardDescription}"`;
      }
    }

    const uomMatch = uomConverter(item.unit, standardUnit);
    const conversionFactor = uomMatch.factor;
    const adj = this.getAdjustmentsForDomain(item.domain);

    // Sequential adjustments
    const rateUOM = basePrice * conversionFactor;
    const rateWastage = rateUOM * (1 + adj.wastage);
    const rateHandling = rateWastage * (1 + adj.handling);
    const rateInstallation = rateHandling * (1 + adj.installation);
    const rateMargin = rateInstallation * (1 + adj.margin);
    const finalRate = rateMargin * locationFactor;

    const confidence = matchedMaster ? 70 : 40;
    const explanation = `[Basic Rate Recommendation Trace]
- Base Sourced From: ${baseSource}
- Base Price Sourced: ₹${basePrice.toFixed(2)}
- 1. UOM Conversion Factor: ${conversionFactor.toFixed(2)} (Running total: ₹${rateUOM.toFixed(2)})
- 2. Material Wastage (${(adj.wastage * 100).toFixed(1)}%): +₹${(rateUOM * adj.wastage).toFixed(2)} (Running total: ₹${rateWastage.toFixed(2)})
- 3. Material Handling (${(adj.handling * 100).toFixed(1)}%): +₹${(rateWastage * adj.handling).toFixed(2)} (Running total: ₹${rateHandling.toFixed(2)})
- 4. Installation Cost (${(adj.installation * 100).toFixed(1)}%): +₹${(rateHandling * adj.installation).toFixed(2)} (Running total: ₹${rateInstallation.toFixed(2)})
- 5. Contractor Margin (${(adj.margin * 100).toFixed(1)}%): +₹${(rateInstallation * adj.margin).toFixed(2)} (Running total: ₹${rateMargin.toFixed(2)})
- 6. Location Factor: ${locationFactor.toFixed(2)} (City: ${city}) (Running total: ₹${finalRate.toFixed(2)})
- Final Recommended Rate: ₹${(Math.round(finalRate * 100) / 100).toFixed(2)}`;

    return {
      recommendedRate: Math.round(finalRate * 100) / 100,
      source: "Basic Rate" as const,
      worksheet: "Master Catalog",
      historicalItem: matchedMaster ? matchedMaster.standardDescription : "Domain Baseline Fallback",
      confidence,
      reason: `[Basic Rate] Sourced from ${matchedMaster ? "Master Catalog" : "Domain Baseline"}. Sequential adjustments: UOM: x${conversionFactor.toFixed(2)}, Wastage: +${(adj.wastage * 100)}%, Handling: +${(adj.handling * 100)}%, Installation: +${(adj.installation * 100)}%, Margin: +${(adj.margin * 100)}%, Location: x${locationFactor.toFixed(2)}.`,
      matchedMasterId: masterId,
      trace: {
        rfqItem: item.originalDescription,
        historicalProject: "None (Basic Rate from Master Catalog)",
        historicalProjectCost: 0,
        historicalProjectType: "N/A",
        historicalWorksheet: "N/A",
        historicalCell: "N/A",
        historicalUnitRate: basePrice,
        recommendedUnitRate: Math.round(finalRate * 100) / 100,
        replayMode: "No" as "Yes" | "No",
        matchType: "Basic Rate Estimation",
        rateSource: "Basic Rate",
        explanation
      }
    };
  }
};
