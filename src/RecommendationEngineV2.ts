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

// Stage 1 of the two-stage retrieval pipeline (Historical Project Ranking). Project Type is
// weighted as the strongest single factor per spec, with Cost/Size/City/Grade all contributing to
// which historical projects even become eligible for Stage 2 item matching - none of these ever
// touch a rate (see RecommendationEngineV2.recommendItem / ProjectCalibrationEngine, which no
// longer apply any location or scale multiplier to a historical rate).
const MIN_PROJECT_SIMILARITY_TO_SHORTLIST = 0.30; // reject poor project matches automatically -
// never pad the shortlist to 5 with a project that isn't genuinely relevant.

export const RecommendationEngineV2 = {
  // STAGE 1: Retrieve the Top 5 similar historical projects (Historical Project Ranking). Must run
  // BEFORE any item-level matching - Stage 2 (src/HistoricalRetrievalEngine.ts /
  // ProjectCalibrationEngine.ts) is bounded to exactly the projects returned here, never the whole
  // historical database.
  getSimilarProjects(
    historicalBOQs: HistoricalBOQ[],
    input: ProjectSimilarityInput,
    historicalCostByProjectId: Map<string, number>
  ): { project: HistoricalBOQ; similarity: number }[] {
    const scored = historicalBOQs.map(h => {
      // 1. Project Type Match (Weight: 30%) - the strongest ranking factor per spec: projects of
      // the same type must score much higher than projects from a different sector.
      const hType = (h.projectType || "Commercial Office").toLowerCase().trim();
      const inputType = input.projectType.toLowerCase().trim();
      const typeSimilarity = hType === inputType ? 1.0 : (hType.includes(inputType) || inputType.includes(hType) ? 0.6 : 0.0);

      // 2. Project Cost Match (Weight: 20%) - real, replay-derived cost per historical project
      // (historicalCostByProjectId, built once in server.ts from actual historical line-item
      // amounts). HistoricalBOQ carries no stored cost field, so this was previously comparing
      // every historical project against the same constant fallback, making cost contribute
      // nothing to ranking - fixed here to be a genuine differentiator (₹40 Cr projects should
      // rank near other commercial-scale projects, not ₹500 Cr ones).
      const hCost = historicalCostByProjectId.get(h.id) || 0;
      const costSimilarity = input.projectCost > 0 && hCost > 0
        ? Math.max(0, 1 - (Math.abs(input.projectCost - hCost) / input.projectCost))
        : 0.5; // neutral, not a phantom perfect/zero match, when real cost data is unavailable

      // 3. Project Size Match (Weight: 20%) - small projects should primarily compare with small
      // projects, large with large; never itself modifies a rate.
      const hSize = h.projectSize ? parseFloat(String(h.projectSize).replace(/[^0-9.]/g, "")) : 50000;
      const sizeDiff = Math.abs(input.projectSize - hSize);
      const sizeSimilarity = input.projectSize > 0 ? Math.max(0, 1 - (sizeDiff / input.projectSize)) : 1.0;

      // 4. City Match (Weight: 20%) - influences which historical PROJECTS are selected only; a
      // city match/mismatch never scales a historical rate up or down (Problem 1 fix).
      const hLoc = (h.location || "").toLowerCase();
      const inputCity = input.city.toLowerCase().trim();
      const citySimilarity = hLoc.includes(inputCity) || inputCity.includes(hLoc) ? 1.0 : 0.0;

      // 5. Building Grade Match (Weight: 10%) - existing keyword-based Building Type proxy (no
      // fabricated industry/construction-scope fields exist in the historical data model yet).
      const pGrade = (h.projectName + " " + (h.projectType || "")).toLowerCase();
      let projectGrade = "Grade A";
      if (pGrade.includes("grade a") || pGrade.includes("premium") || pGrade.includes("luxury")) {
        projectGrade = "Grade A";
      } else if (pGrade.includes("grade b") || pGrade.includes("standard")) {
        projectGrade = "Grade B";
      }
      const inputGrade = input.buildingGrade.toLowerCase().trim();
      const gradeSimilarity = projectGrade.includes(inputGrade) || inputGrade.includes(projectGrade) ? 1.0 : 0.5;

      const similarity = (typeSimilarity * 0.30) + (costSimilarity * 0.20) + (sizeSimilarity * 0.20) + (citySimilarity * 0.20) + (gradeSimilarity * 0.10);
      return { project: h, similarity };
    });

    return scored
      .filter(s => s.similarity >= MIN_PROJECT_SIMILARITY_TO_SHORTLIST)
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

  // One recommendation engine, no historical-BOQ special case: every item is priced from this
  // same baseline-then-recalibrate path, whether or not it happens to be a verbatim match for a
  // historical record. There is no separate "exact match -> return the stored rate" branch here
  // any more - an exact description match is simply strong evidence, and gets its say entirely
  // through HistoricalRetrievalEngine's ranked candidates / ProjectCalibrationEngine's weighted
  // market-rate statistics (which run unconditionally afterward, in server.ts) - never through an
  // early return that bypasses that evidence pool.
  recommendItem(
    item: RFQItem,
    top5Projects: HistoricalBOQ[],
    replayDatabase: ReplayRecord[],
    descriptionToMasterIdIndex: Record<string, string>,
    masterItemIdIndex: Record<string, MasterBOQItem>,
    city: string,
    uomConverter: (rfqUnit: string, targetUnit: string) => { factor: number; compatible: boolean; trace: string[] }
  ) {
    const descKey = item.originalDescription.toLowerCase().trim();
    const itemDomainKey = (item.domain || "").toLowerCase().trim();

    // Baseline rate: classify which Master Catalog item this description resembles (item
    // understanding), then apply engineering/market sequential adjustments. This baseline is
    // always subject to the same downstream weighted-evidence recalibration as every other item.
    const masterId = descriptionToMasterIdIndex[`${itemDomainKey}::${descKey}`];
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

    // m.basicRate/averageRate/medianRate (see server.ts's precomputeMasterItemFields, where
    // basicRate is itself just set to medianRate||averageRate) are ALL historical aggregates -
    // real market rates already inclusive of contractor margin, labour, wastage, handling,
    // overheads, and normal commercial pricing, because that's what a historical BOQ rate is.
    // Sequential wastage/handling/installation/margin build-up must therefore NEVER be applied on
    // top of them - that would double-count commercial markup that's already baked in. The build-
    // up stack is legitimate ONLY for the true no-evidence-at-all case (basePrice falling back to
    // the flat ₹1000 domain default because no Master Catalog item was found), where there is no
    // historical commercial rate to preserve and a rate genuinely has to be built up from scratch.
    // A genuine engineering difference (different size/dimension) is handled separately and only
    // afterward, by EngineeringAdjustmentEngine in server.ts - never by re-applying this stack.
    let finalRate: number;
    let explanation: string;
    let reason: string;

    if (matchedMaster) {
      finalRate = basePrice * conversionFactor;
      explanation = `[Historical Commercial Rate]
- Base Sourced From: ${baseSource}
- Historical Commercial Rate: ₹${basePrice.toFixed(2)} (already inclusive of margin, labour, wastage, handling and overheads - no commercial markup re-applied)
- UOM Conversion Factor: ${conversionFactor.toFixed(2)}
- Final Recommended Rate: ₹${(Math.round(finalRate * 100) / 100).toFixed(2)} (historical rate used directly; only a genuine engineering/dimensional difference, if any, adjusts it further downstream)`;
      reason = `[Historical Commercial Rate] Sourced from ${baseSource}, used directly as a final market rate. UOM Factor: x${conversionFactor.toFixed(2)}. No wastage/handling/installation/margin re-applied - the historical rate already includes these.`;
    } else {
      const adj = this.getAdjustmentsForDomain(item.domain);
      const rateUOM = basePrice * conversionFactor;
      const rateWastage = rateUOM * (1 + adj.wastage);
      const rateHandling = rateWastage * (1 + adj.handling);
      const rateInstallation = rateHandling * (1 + adj.installation);
      // No city re-basing here either (Problem 1) - the Basic Rate estimate stands on its own
      // engineering/market adjustments only.
      finalRate = rateInstallation * (1 + adj.margin);
      explanation = `[Basic Rate Recommendation Trace - no historical evidence found, full cost build-up]
- Base Sourced From: ${baseSource}
- Base Price Sourced: ₹${basePrice.toFixed(2)}
- 1. UOM Conversion Factor: ${conversionFactor.toFixed(2)} (Running total: ₹${rateUOM.toFixed(2)})
- 2. Material Wastage (${(adj.wastage * 100).toFixed(1)}%): +₹${(rateUOM * adj.wastage).toFixed(2)} (Running total: ₹${rateWastage.toFixed(2)})
- 3. Material Handling (${(adj.handling * 100).toFixed(1)}%): +₹${(rateWastage * adj.handling).toFixed(2)} (Running total: ₹${rateHandling.toFixed(2)})
- 4. Installation Cost (${(adj.installation * 100).toFixed(1)}%): +₹${(rateHandling * adj.installation).toFixed(2)} (Running total: ₹${rateInstallation.toFixed(2)})
- 5. Contractor Margin (${(adj.margin * 100).toFixed(1)}%): +₹${(rateInstallation * adj.margin).toFixed(2)} (Running total: ₹${finalRate.toFixed(2)})
- Final Recommended Rate: ₹${(Math.round(finalRate * 100) / 100).toFixed(2)} (no city re-basing applied)`;
      reason = `[Basic Rate] No historical evidence found - built up from ${baseSource}. Sequential adjustments: UOM: x${conversionFactor.toFixed(2)}, Wastage: +${(adj.wastage * 100)}%, Handling: +${(adj.handling * 100)}%, Installation: +${(adj.installation * 100)}%, Margin: +${(adj.margin * 100)}%.`;
    }

    // A genuine, commercially-equivalent historical match deserves real trust (no markup was
    // guessed on top of it) - not the same low confidence as a from-scratch domain-default guess.
    const confidence = matchedMaster ? 85 : 40;

    return {
      recommendedRate: Math.round(finalRate * 100) / 100,
      source: "Basic Rate" as const,
      worksheet: "Master Catalog",
      historicalItem: matchedMaster ? matchedMaster.standardDescription : "Domain Baseline Fallback",
      confidence,
      reason,
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
        matchType: "Basic Rate Estimation",
        rateSource: "Basic Rate",
        explanation
      }
    };
  }
};
