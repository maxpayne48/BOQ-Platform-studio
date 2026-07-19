import { MasterBOQItem } from "./types.js";

/**
 * InstallationRateEngine
 *
 * Additive layer on top of the existing Supply Rate recommendation (RecommendationEngineV2 /
 * RecommendationV2 in server.ts, both untouched). Installation Rate is NEVER recommended
 * independently - it is always derived from the final Recommended Supply Rate:
 *
 *   Recommended Installation = Recommended Supply x Final Installation %
 *
 * The domain baseline percentage is the anchor (Priority 1) for every item. Historical
 * Supply/Installation data (Priority 2) can only ever nudge that baseline, never replace it
 * wholesale: a historical median more than +-8 percentage points away from the domain baseline
 * is treated as an outlier from a different project's context and ignored outright; one within
 * tolerance is blended 70% baseline / 30% historical. This prevents one historical project's
 * unusual pricing (e.g. a 40-45% HVAC/Electrical installation ratio) from ever propagating into
 * an unrealistic recommendation for a different project.
 *
 * City multipliers are never applied here: Installation Rate is derived purely as a percentage
 * of the (already location-adjusted, once) recommended Supply Rate passed in - no second/
 * separate location factor is ever applied on top.
 */

export interface InstallationRateResult {
  installationRate: number;
  installationPercentage: number; // the Final Installation % actually used, e.g. 0.15 for 15%
  installationReferenceCount: number; // historical occurrences considered (0 if none/ignored)
  domainLabel: string;
  domainBaselinePercentage: number;
  historicalMedianPercentage: number | null; // null when no usable historical data existed at all
  reason: "Baseline" | "Blended" | "Historical Ignored";
}

interface DomainBaselineEntry {
  label: string;
  percentage: number;
  keywords: string[];
}

// Ordered most-specific-first: a domain checked earlier "wins" if its keywords also happen to
// overlap a more generic domain checked later (e.g. "Fire Alarm"/"Fire Fighting" before generic
// "Mechanical"; "Passive Networking"/"ELV" before generic "Electrical").
const DOMAIN_BASELINE_PERCENTAGES: DomainBaselineEntry[] = [
  { label: "Fire Alarm", percentage: 0.15, keywords: ["fire alarm", "smoke detector", "heat detector"] },
  { label: "Fire Fighting", percentage: 0.16, keywords: ["fire fighting", "firefighting", "sprinkler", "hydrant", "fire pump"] },
  { label: "Passive Networking", percentage: 0.15, keywords: ["passive networking", "structured cabling", "data cable", "lan cable", "cat6", "cat 6"] },
  { label: "ELV", percentage: 0.15, keywords: ["elv", "cctv", "access control", "biometric", "bms"] },
  { label: "HVAC", percentage: 0.10, keywords: ["hvac", "ahu", "vrf", "vrv", "chiller", "fcu", "duct", "ducting"] },
  { label: "Mechanical", percentage: 0.15, keywords: ["mechanical"] },
  { label: "PHE", percentage: 0.20, keywords: ["phe", "plumbing", "sanitary", "pipe", "piping", "wash basin", "valve", "fitting"] },
  { label: "Electrical", percentage: 0.15, keywords: ["electrical", "conduit", "switch", "socket", "light fixture", "luminaire", "panel", "cable", "wiring"] },
  { label: "Stone", percentage: 0.28, keywords: ["stone cladding", "granite cladding", "marble cladding", "stone work"] },
  { label: "Flooring", percentage: 0.25, keywords: ["floor", "tile", "vitrified", "kota stone", "screed"] },
  { label: "False Ceiling", percentage: 0.18, keywords: ["false ceiling", "gypsum ceiling", "grid ceiling", "tegular ceiling"] },
  { label: "Partitions", percentage: 0.20, keywords: ["partition", "glass partition", "wooden partition", "glazed partition"] },
  { label: "Painting", percentage: 0.30, keywords: ["paint", "emulsion", "distemper", "primer coat"] },
  { label: "Furniture", percentage: 0.12, keywords: ["furniture", "workstation", "veneer", "laminate"] },
  { label: "Signage", percentage: 0.15, keywords: ["signage", "sign board"] },
  { label: "Graphics", percentage: 0.18, keywords: ["graphics", "vinyl film", "wall wrap", "branding film"] },
  { label: "Civil", percentage: 0.22, keywords: ["civil", "masonry", "brickwork", "brick work", "aac block", "block work", "plaster", "waterproof", "concrete", "rcc", "pcc"] }
];

// Last-resort domain when no keyword matches anything above - a recommendation must still
// always be produced.
const GENERIC_DOMAIN: DomainBaselineEntry = { label: "General", percentage: 0.15, keywords: [] };

const OUTLIER_TOLERANCE_PP = 0.08; // +-8 percentage points
const BASELINE_WEIGHT = 0.70;
const HISTORICAL_WEIGHT = 0.30;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Standard IQR fence trim before taking the historical median - a first pass of outlier
// removal across the raw per-occurrence ratios, ahead of the baseline-comparison check below.
function trimOutliersByIQR(values: number[]): number[] {
  if (values.length < 4) return values; // too few points to meaningfully IQR-trim
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  return values.filter((v) => v >= lower && v <= upper);
}

function resolveDomain(searchText: string): DomainBaselineEntry {
  const normalized = searchText.toLowerCase();
  for (const entry of DOMAIN_BASELINE_PERCENTAGES) {
    if (entry.keywords.some((k) => normalized.includes(k))) {
      return entry;
    }
  }
  return GENERIC_DOMAIN;
}

export const InstallationRateEngine = {
  /**
   * @param supplyRate The already-finalized recommended Supply Rate (post UOM/location
   *   adjustment) - never recomputed or modified here.
   * @param matchedMaster The Master BOQ item the Supply Rate was matched against, if any.
   * @param searchText Free text (subcategory + category + item description) used for domain
   *   baseline keyword matching.
   */
  computeInstallationRate(
    supplyRate: number,
    matchedMaster: MasterBOQItem | null | undefined,
    searchText: string
  ): InstallationRateResult {
    // Priority 1: domain baseline - always resolved first, the anchor for every item.
    const domain = resolveDomain(searchText);
    const baseline = domain.percentage;

    // Priority 2: historical Supply/Installation data, if any, can only nudge the baseline.
    let historicalMedianPercentage: number | null = null;
    let referenceCount = 0;
    if (matchedMaster && matchedMaster.supplyRate && matchedMaster.installationRate) {
      const ratios: number[] = [];
      const len = Math.min(matchedMaster.supplyRate.length, matchedMaster.installationRate.length);
      for (let i = 0; i < len; i++) {
        const s = matchedMaster.supplyRate[i];
        const inst = matchedMaster.installationRate[i];
        if (s > 0 && inst >= 0) {
          ratios.push(inst / s);
        }
      }
      const trimmed = trimOutliersByIQR(ratios);
      if (trimmed.length > 0) {
        historicalMedianPercentage = median(trimmed);
        referenceCount = trimmed.length;
      }
    }

    let finalPercentage = baseline;
    let reason: InstallationRateResult["reason"] = "Baseline";

    if (historicalMedianPercentage !== null) {
      const deviation = Math.abs(historicalMedianPercentage - baseline);
      if (deviation > OUTLIER_TOLERANCE_PP) {
        // Never allow one project's historical pricing to produce an unrealistic percentage
        // for another project - discard it and use the domain baseline alone.
        finalPercentage = baseline;
        reason = "Historical Ignored";
      } else {
        finalPercentage = BASELINE_WEIGHT * baseline + HISTORICAL_WEIGHT * historicalMedianPercentage;
        reason = "Blended";
      }
    }

    const installationRate = Math.max(0, Math.round(supplyRate * finalPercentage * 100) / 100);

    return {
      installationRate,
      installationPercentage: finalPercentage,
      installationReferenceCount: reason === "Historical Ignored" ? 0 : referenceCount,
      domainLabel: domain.label,
      domainBaselinePercentage: baseline,
      historicalMedianPercentage,
      reason
    };
  }
};
