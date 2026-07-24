import { MasterBOQItem } from "./types.js";

// Additive layer on top of the existing "Basic Rate" fallback path in RecommendationEngineV2.
// Never invoked for, and never alters, an exact historical match ("Historical Rate" source) -
// that path is frozen and continues to behave exactly as before. This engine only fires when
// no exact historical item exists, replacing a flat catalog-average guess with a dimensionally
// grounded estimate (interpolation / extrapolation / area scaling / regression) built from other
// master items in the same item "family" (same description with a different size/parameter).

export interface EngineeringParameter {
  name: "Width" | "Height" | "Depth" | "Diameter" | "Thickness" | "Dimension";
  value: number;
  unit: string;
}

export interface FamilyReferencePoint {
  description: string;
  dimensionValue: number;
  secondaryValue?: number;
  tertiaryValue?: number;
  rate: number;
  masterId: string;
}

export interface EngineeringAdjustmentResult {
  applied: boolean;
  finalRate: number;
  mathematicalModel: "Linear Interpolation" | "Linear Extrapolation" | "Area Scaling" | "Volume Scaling" | "Historical Regression" | "None";
  engineeringParameters: EngineeringParameter[];
  familyKey: string;
  historicalReferencesUsed: FamilyReferencePoint[];
  calculatedAdjustment: string;
  confidence: number;
  isExtrapolation: boolean;
  rateVariationPercent: number | null;
  explanation: string;
}

interface ExtractedDescriptor {
  parameters: EngineeringParameter[];
  familyKey: string;
  primaryDimension: number | null;
  secondaryDimension: number | null;
  tertiaryDimension: number | null;
  kind: "3D" | "2D" | "1D" | "none";
}

const UNIT_STRIP_REGEX = /\d+(?:\.\d+)?\s*(mm|cm|m|inch|in|kw|ton|tr|cfm|sqft|sqm|nos|no\.?)\b/gi;

function extractDescriptor(description: string): ExtractedDescriptor {
  const text = description || "";
  let strippedText = text;
  const parameters: EngineeringParameter[] = [];
  let primaryDimension: number | null = null;
  let secondaryDimension: number | null = null;
  let tertiaryDimension: number | null = null;
  let kind: ExtractedDescriptor["kind"] = "none";

  // Tier 0: three-axis furniture/joinery callouts - e.g. "800mm H X 750mm D X 3110mm L",
  // "2500mm L X 900mm W X 1000mm H". Each number may carry a single axis-letter (H/W/D/L/T)
  // between the unit and the "x" separator, which the plain W x H regex below can't cross - so
  // without this tier, items differing only in their third dimension (e.g. two credenzas of the
  // same height/depth but different length) were falling through to Tier 4 and being extracted as
  // an identical single "800mm" dimension, making genuinely different-sized items indistinguishable.
  const dim3DRegex = /(\d+(?:\.\d+)?)\s*(mm|cm|m|inch|in)?\s*[HWDLT]?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|inch|in)?\s*[HWDLT]?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|inch|in)?\s*[HWDLT]?\b/i;
  const dim3DMatch = text.match(dim3DRegex);
  if (dim3DMatch) {
    primaryDimension = parseFloat(dim3DMatch[1]);
    secondaryDimension = parseFloat(dim3DMatch[3]);
    tertiaryDimension = parseFloat(dim3DMatch[5]);
    const unit = dim3DMatch[2] || dim3DMatch[4] || dim3DMatch[6] || "mm";
    parameters.push({ name: "Width", value: primaryDimension, unit });
    parameters.push({ name: "Depth", value: secondaryDimension, unit });
    parameters.push({ name: "Height", value: tertiaryDimension, unit });
    kind = "3D";
    strippedText = strippedText.replace(dim3DMatch[0], " ");
  } else {
  // Tier 1: Width x Height (2D) - e.g. "1000x2100", "1000mm x 2100mm"
  const dim2DRegex = /(\d+(?:\.\d+)?)\s*(mm|cm|m)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)?/i;
  const dim2DMatch = text.match(dim2DRegex);
  if (dim2DMatch) {
    primaryDimension = parseFloat(dim2DMatch[1]);
    secondaryDimension = parseFloat(dim2DMatch[3]);
    const unit = dim2DMatch[2] || dim2DMatch[4] || "mm";
    parameters.push({ name: "Width", value: primaryDimension, unit });
    parameters.push({ name: "Height", value: secondaryDimension, unit });
    kind = "2D";
    strippedText = strippedText.replace(dim2DMatch[0], " ");
  } else {
    // Tier 2: Diameter - e.g. "50mm dia", "dia 50mm"
    const diaRegex = /(\d+(?:\.\d+)?)\s*(mm|cm|inch|in)?\s*dia(?:meter)?\b|\bdia(?:meter)?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(mm|cm|inch|in)?/i;
    const diaMatch = text.match(diaRegex);
    if (diaMatch) {
      primaryDimension = parseFloat(diaMatch[1] || diaMatch[3]);
      const unit = diaMatch[2] || diaMatch[4] || "mm";
      parameters.push({ name: "Diameter", value: primaryDimension, unit });
      kind = "1D";
      strippedText = strippedText.replace(diaMatch[0], " ");
    } else {
      // Tier 3: Thickness - e.g. "150mm thick", "100mm thk"
      const thkRegex = /(\d+(?:\.\d+)?)\s*(mm|cm|inch|in)?\s*(?:thk|thick(?:ness)?)\b/i;
      const thkMatch = text.match(thkRegex);
      if (thkMatch) {
        primaryDimension = parseFloat(thkMatch[1]);
        const unit = thkMatch[2] || "mm";
        parameters.push({ name: "Thickness", value: primaryDimension, unit });
        kind = "1D";
        strippedText = strippedText.replace(thkMatch[0], " ");
      } else {
        // Tier 4: generic single numeric dimension + unit fallback (capacity/gauge/area/etc.)
        const genRegex = /(\d+(?:\.\d+)?)\s*(mm|cm|inch|in|kw|ton|tr|cfm|sqft|sqm)\b/i;
        const genMatch = text.match(genRegex);
        if (genMatch) {
          primaryDimension = parseFloat(genMatch[1]);
          const unit = genMatch[2];
          parameters.push({ name: "Dimension", value: primaryDimension, unit });
          kind = "1D";
          strippedText = strippedText.replace(genMatch[0], " ");
        }
      }
    }
  }
  }

  const familyKey = strippedText
    .toLowerCase()
    .replace(UNIT_STRIP_REGEX, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { parameters, familyKey, primaryDimension, secondaryDimension, tertiaryDimension, kind };
}

function wordOverlap(a: string, b: string): number {
  const wa = new Set(a.split(" ").filter((w) => w.length > 2));
  const wb = new Set(b.split(" ").filter((w) => w.length > 2));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  wa.forEach((w) => {
    if (wb.has(w)) common++;
  });
  return common / Math.max(wa.size, wb.size);
}

const FAMILY_OVERLAP_THRESHOLD = 0.6;

// Commercial Equivalence Gate: text-similarity scoring (wordOverlap above, or
// HistoricalRetrievalEngine's own wordOverlapScore) cannot tell "12mm Toughened Glass" from
// "12mm Fire Rated Glass" apart - both share most of their words and score a high overlap, but
// they are different, non-interchangeable commercial products. This is a curated, deliberately
// generic (not per-work-category) list of "distinguishing qualifier" terms that materially change
// a product regardless of domain - if one description carries a qualifier the other doesn't, the
// pair is commercially non-equivalent, full stop, no matter how similar the rest of the text is.
// Best-effort and generalizable, not a claim of a complete product ontology - extend the list if a
// new recurring mismatch class is found, rather than adding per-item-category special cases.
const DISTINGUISHING_QUALIFIERS: string[] = [
  "fire rated", "fire-rated", "fire retardant", "fire resistant",
  "acoustic rated", "acoustic",
  "waterproof", "weatherproof", "weather proof",
  "toughened", "tempered", "heat strengthened", "laminated",
  "insulated", "double glazed", "low-e", "low e",
  "anti-bacterial", "antibacterial",
  "galvanized", "galvanised", "stainless", "powder coated", "anodized", "anodised",
  "blast resistant", "bullet resistant", "ballistic",
  "termite proof", "termite-proof",
  "food grade", "marine grade"
];

export function isCommerciallyEquivalent(descA: string, descB: string): { equivalent: boolean; reason?: string } {
  const a = (descA || "").toLowerCase();
  const b = (descB || "").toLowerCase();
  for (const qualifier of DISTINGUISHING_QUALIFIERS) {
    const inA = a.includes(qualifier);
    const inB = b.includes(qualifier);
    if (inA !== inB) {
      return { equivalent: false, reason: `Commercially non-equivalent: "${qualifier}" present in only one description` };
    }
  }
  return { equivalent: true };
}

function noAdjustment(fallbackRate: number, target: ExtractedDescriptor): EngineeringAdjustmentResult {
  return {
    applied: false,
    finalRate: fallbackRate,
    mathematicalModel: "None",
    engineeringParameters: target.parameters,
    familyKey: target.familyKey,
    historicalReferencesUsed: [],
    calculatedAdjustment: "",
    confidence: 0,
    isExtrapolation: false,
    rateVariationPercent: null,
    explanation: "No engineering adjustment applied - insufficient dimensional family reference data to build an interpolation/extrapolation model; the Basic Rate catalog estimate was used as-is."
  };
}

export const EngineeringAdjustmentEngine = {
  // Exposed for the Dashboard's "Limited Historical References" / debug needs without recomputing.
  extractDescriptor,

  // Exposed for src/HistoricalRetrievalEngine.ts's Commercial Equivalence filtering gate - the same
  // qualifier-symmetry check used internally below (family-reference filtering) is reused there so
  // both engines agree on what counts as "the same product."
  isCommerciallyEquivalent,

  computeEngineeringAdjustment(
    itemDescription: string,
    fallbackRate: number,
    allMasterItems: MasterBOQItem[]
  ): EngineeringAdjustmentResult {
    const target = extractDescriptor(itemDescription);
    if (target.primaryDimension === null || !target.familyKey) {
      return noAdjustment(fallbackRate, target);
    }

    const byDimension = new Map<number, FamilyReferencePoint>();
    for (const m of allMasterItems) {
      if (!m.standardDescription) continue;
      const cand = extractDescriptor(m.standardDescription);
      if (cand.primaryDimension === null || !cand.familyKey || cand.kind !== target.kind) continue;
      if (wordOverlap(target.familyKey, cand.familyKey) < FAMILY_OVERLAP_THRESHOLD) continue;
      // Commercial Equivalence Gate: family-key word overlap alone can't tell "toughened" from
      // "fire rated" glass apart (both strip to a similar family key) - never build an
      // interpolation/extrapolation model across genuinely different products just because their
      // non-dimensional wording happens to overlap enough.
      if (!isCommerciallyEquivalent(itemDescription, m.standardDescription).equivalent) continue;
      const rate = m.averageRate || m.medianRate || m.latestRate || 0;
      if (rate <= 0) continue;

      const existing = byDimension.get(cand.primaryDimension);
      if (!existing || m.occurrenceCount > 1) {
        byDimension.set(cand.primaryDimension, {
          description: m.standardDescription,
          dimensionValue: cand.primaryDimension,
          secondaryValue: cand.secondaryDimension ?? undefined,
          tertiaryValue: cand.tertiaryDimension ?? undefined,
          rate,
          masterId: m.id
        });
      }
    }

    const references = Array.from(byDimension.values()).sort((a, b) => a.dimensionValue - b.dimensionValue);
    if (references.length < 2) {
      return noAdjustment(fallbackRate, target);
    }

    const primaryDimension = target.primaryDimension as number;
    const minDim = references[0].dimensionValue;
    const maxDim = references[references.length - 1].dimensionValue;
    const isExtrapolation = primaryDimension < minDim || primaryDimension > maxDim;

    let calculatedRate: number;
    let model: EngineeringAdjustmentResult["mathematicalModel"];

    if (target.kind === "3D") {
      const targetVolume = primaryDimension * (target.secondaryDimension || primaryDimension) * (target.tertiaryDimension || primaryDimension);
      let nearest = references[0];
      let nearestDiff = Infinity;
      for (const r of references) {
        const rVolume = r.dimensionValue * (r.secondaryValue || r.dimensionValue) * (r.tertiaryValue || r.dimensionValue);
        const diff = Math.abs(rVolume - targetVolume);
        if (diff < nearestDiff) {
          nearestDiff = diff;
          nearest = r;
        }
      }
      const nearestVolume = nearest.dimensionValue * (nearest.secondaryValue || nearest.dimensionValue) * (nearest.tertiaryValue || nearest.dimensionValue);
      calculatedRate = nearestVolume > 0 ? nearest.rate * (targetVolume / nearestVolume) : nearest.rate;
      model = "Volume Scaling";
    } else if (target.kind === "2D") {
      const targetArea = primaryDimension * (target.secondaryDimension || primaryDimension);
      let nearest = references[0];
      let nearestDiff = Infinity;
      for (const r of references) {
        const rArea = r.dimensionValue * (r.secondaryValue || r.dimensionValue);
        const diff = Math.abs(rArea - targetArea);
        if (diff < nearestDiff) {
          nearestDiff = diff;
          nearest = r;
        }
      }
      const nearestArea = nearest.dimensionValue * (nearest.secondaryValue || nearest.dimensionValue);
      calculatedRate = nearestArea > 0 ? nearest.rate * (targetArea / nearestArea) : nearest.rate;
      model = "Area Scaling";
    } else if (references.length >= 3) {
      const n = references.length;
      const sumX = references.reduce((s, r) => s + r.dimensionValue, 0);
      const sumY = references.reduce((s, r) => s + r.rate, 0);
      const sumXY = references.reduce((s, r) => s + r.dimensionValue * r.rate, 0);
      const sumX2 = references.reduce((s, r) => s + r.dimensionValue * r.dimensionValue, 0);
      const denom = n * sumX2 - sumX * sumX;
      if (Math.abs(denom) < 1e-9) {
        calculatedRate = references[0].rate;
        model = "Linear Interpolation";
      } else {
        const slope = (n * sumXY - sumX * sumY) / denom;
        const intercept = (sumY - slope * sumX) / n;
        calculatedRate = slope * primaryDimension + intercept;
        model = isExtrapolation ? "Linear Extrapolation" : "Historical Regression";
      }
    } else {
      const [p1, p2] = references;
      const slope = (p2.rate - p1.rate) / (p2.dimensionValue - p1.dimensionValue || 1);
      calculatedRate = p1.rate + slope * (primaryDimension - p1.dimensionValue);
      model = isExtrapolation ? "Linear Extrapolation" : "Linear Interpolation";
    }

    if (!Number.isFinite(calculatedRate) || calculatedRate <= 0) {
      return noAdjustment(fallbackRate, target);
    }

    let nearestRef = references[0];
    let nearestRefDiff = Infinity;
    for (const r of references) {
      const diff = Math.abs(r.dimensionValue - primaryDimension);
      if (diff < nearestRefDiff) {
        nearestRefDiff = diff;
        nearestRef = r;
      }
    }

    const blended = 0.7 * calculatedRate + 0.3 * nearestRef.rate;
    const finalRate = Math.round(blended * 100) / 100;

    let confidence = isExtrapolation ? 55 : 78;
    confidence += Math.min(references.length, 5) * 2;
    if (isExtrapolation) {
      const range = maxDim - minDim || 1;
      const distanceOutside = primaryDimension < minDim ? minDim - primaryDimension : primaryDimension - maxDim;
      confidence -= Math.min(30, (distanceOutside / range) * 40);
    }
    confidence = Math.max(30, Math.min(92, Math.round(confidence)));

    const rates = references.map((r) => r.rate);
    const meanRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    const variance = rates.reduce((s, r) => s + Math.pow(r - meanRate, 2), 0) / rates.length;
    const stdDev = Math.sqrt(variance);
    const rateVariationPercent = meanRate > 0 ? Math.round((stdDev / meanRate) * 1000) / 10 : null;

    const refSummary = references
      .map((r) => `${r.dimensionValue}${target.kind === "2D" || target.kind === "3D" ? "" : target.parameters[0]?.unit || "mm"}=₹${r.rate.toFixed(2)}`)
      .join(", ");

    const explanation =
      `Engineering Adjustment: no exact historical match for "${itemDescription}". Classified into family ` +
      `"${target.familyKey}" with ${references.length} historical reference size(s) (${refSummary}). Applied ` +
      `${model}${isExtrapolation ? " (target dimension falls outside the historical data range)" : " (target dimension falls within the historical data range)"} ` +
      `to calculate ₹${calculatedRate.toFixed(2)}, blended 70/30 with the nearest historical reference ` +
      `(₹${nearestRef.rate.toFixed(2)} @ ${nearestRef.dimensionValue}) for a final recommended rate of ₹${finalRate.toFixed(2)}.`;

    return {
      applied: true,
      finalRate,
      mathematicalModel: model,
      engineeringParameters: target.parameters,
      familyKey: target.familyKey,
      historicalReferencesUsed: references,
      calculatedAdjustment: `${model}: ${isExtrapolation ? "extrapolated" : "interpolated"} from ${references.length} reference size(s) -> ₹${calculatedRate.toFixed(2)}, blended with nearest (₹${nearestRef.rate.toFixed(2)}) = ₹${finalRate.toFixed(2)}`,
      confidence,
      isExtrapolation,
      rateVariationPercent,
      explanation
    };
  }
};
