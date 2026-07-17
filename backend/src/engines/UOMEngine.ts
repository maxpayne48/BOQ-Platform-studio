/**
 * UOMEngine (implemented)
 *
 * Standardizes and converts Units of Measurement. Its only responsibility is to compare,
 * normalize, validate, and convert engineering quantities - it never calculates a
 * recommendation, never adjusts a rate, never applies wastage or margins. Pure and
 * stateless: no persistence, no I/O, no dependency on any other engine's implementation
 * (only on EngineeringParser's, HistoricalRateEngine's, and BasicRateEngine's exported
 * *types*, all frozen, used solely to describe this engine's own input shape).
 */

import type { EngineeringItem } from "./EngineeringParser.js";
import type { HistoricalRateCandidate } from "./HistoricalRateEngine.js";
import type { BasicRateResult } from "./BasicRateEngine.js";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface UOMAnalysisQuery {
  engineeringItem: EngineeringItem;
  historicalMatch?: HistoricalRateCandidate;
  /**
   * BasicRateResult (backend/src/engines/BasicRateEngine.ts, frozen) does not carry a UOM
   * field on its output, so it cannot itself supply a conversion target. Accepted here for
   * input-shape fidelity with that engine's real, frozen return type; analyzeEngineeringItem
   * falls back to normalizing the EngineeringItem's own unit when only this is provided.
   */
  basicRateMatch?: BasicRateResult;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface UOMConversionResult {
  originalUOM: string;
  normalizedUOM: string;
  convertedQuantity: number;
  conversionFactor?: number;
  conversionApplied: boolean;
  compatible: boolean;
}

export type UnitFamily =
  | "length"
  | "area"
  | "volume"
  | "weight"
  | "count"
  | "packaging"
  | "electrical"
  | "mechanical"
  | "unknown";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface IUOMEngine {
  /** Converts a quantity from one unit to another. compatible=false if no valid conversion exists. */
  convert(fromUOM: string, toUOM: string, quantity?: number): UOMConversionResult;

  /** Resolves any known alias/casing/spacing variant to its single canonical unit string. */
  normalize(uom: string): string;

  detectUnitFamily(uom: string): UnitFamily;

  /** Quick compatibility check without building a full conversion result. */
  areCompatible(fromUOM: string, toUOM: string): boolean;

  /** Convenience wrapper: compares an EngineeringItem's own unit against whichever match is given. */
  analyzeEngineeringItem(query: UOMAnalysisQuery): UOMConversionResult;
}

// ---------------------------------------------------------------------------
// Supported UOM table
// ---------------------------------------------------------------------------

interface UOMDefinition {
  canonical: string;
  family: UnitFamily;
  /** Multiply a quantity in this unit by baseFactor to get the family's base unit. Ignored
   *  for families that are not dimensionally convertible (count/packaging/electrical),
   *  where only an identical unit or an explicit SPECIAL_CONVERSIONS entry ever applies. */
  baseFactor: number;
  /** Pre-stripped (lowercase, letters/digits only) alias keys, including the canonical's own form. */
  aliases: string[];
}

const UOM_DEFINITIONS: UOMDefinition[] = [
  // --- Length (base: mm) ---
  { canonical: "MM", family: "length", baseFactor: 1, aliases: ["mm", "millimeter", "millimetre"] },
  { canonical: "CM", family: "length", baseFactor: 10, aliases: ["cm", "centimeter", "centimetre"] },
  { canonical: "M", family: "length", baseFactor: 1000, aliases: ["m", "meter", "metre", "mtr"] },
  { canonical: "KM", family: "length", baseFactor: 1_000_000, aliases: ["km", "kilometer", "kilometre"] },
  { canonical: "INCH", family: "length", baseFactor: 25.4, aliases: ["inch", "inches", "in"] },
  { canonical: "FT", family: "length", baseFactor: 304.8, aliases: ["ft", "feet", "foot"] },

  // --- Area (base: sqmm) ---
  { canonical: "SQMM", family: "area", baseFactor: 1, aliases: ["sqmm", "squaremillimeter", "squaremillimetre", "mm2"] },
  { canonical: "SQCM", family: "area", baseFactor: 100, aliases: ["sqcm", "squarecentimeter", "squarecentimetre", "cm2"] },
  {
    canonical: "SQM",
    family: "area",
    baseFactor: 1_000_000,
    aliases: ["sqm", "sqmt", "squaremeter", "squaremetre", "m2", "smt"]
  },
  { canonical: "SQFT", family: "area", baseFactor: 92_903.04, aliases: ["sqft", "squarefeet", "squarefoot", "ft2"] },
  { canonical: "ACRE", family: "area", baseFactor: 4_046_856_422.4, aliases: ["acre", "acres"] },

  // --- Volume (base: cumm) ---
  { canonical: "CUMM", family: "volume", baseFactor: 1, aliases: ["cumm", "cubicmillimeter", "cubicmillimetre", "mm3"] },
  { canonical: "CUM", family: "volume", baseFactor: 1e9, aliases: ["cum", "cubicmeter", "cubicmetre", "m3", "cumt"] },
  { canonical: "LITRE", family: "volume", baseFactor: 1e6, aliases: ["litre", "liter", "ltr", "l"] },
  { canonical: "KL", family: "volume", baseFactor: 1e9, aliases: ["kl", "kilolitre", "kiloliter"] },

  // --- Weight (base: g). "mt" is reserved for metric tonne (dominant BOQ convention), not metre. ---
  { canonical: "G", family: "weight", baseFactor: 1, aliases: ["g", "gram", "grams", "gm"] },
  { canonical: "KG", family: "weight", baseFactor: 1000, aliases: ["kg", "kilogram", "kilograms", "kgs"] },
  {
    canonical: "TONNE",
    family: "weight",
    baseFactor: 1_000_000,
    aliases: ["tonne", "tonnes", "ton", "tons", "mt", "metricton", "metrictonne"]
  },
  { canonical: "LB", family: "weight", baseFactor: 453.592, aliases: ["lb", "lbs", "pound", "pounds"] },

  // --- Count (base: nos). PAIR has a genuine fixed 1:2 relationship to NOS (handled as a
  //     special case below); SET has no universal size and is never cross-convertible. ---
  {
    canonical: "NOS",
    family: "count",
    baseFactor: 1,
    aliases: ["nos", "no", "number", "numbers", "each", "ea", "pcs", "piece", "pieces", "unit", "units"]
  },
  { canonical: "PAIR", family: "count", baseFactor: 2, aliases: ["pair", "pairs", "prs", "pr"] },
  { canonical: "SET", family: "count", baseFactor: NaN, aliases: ["set", "sets"] },

  // --- Packaging: discrete containers, never cross-convertible even within the family. ---
  { canonical: "BAG", family: "packaging", baseFactor: 1, aliases: ["bag", "bags"] },
  { canonical: "BOX", family: "packaging", baseFactor: 1, aliases: ["box", "boxes"] },
  { canonical: "ROLL", family: "packaging", baseFactor: 1, aliases: ["roll", "rolls"] },
  { canonical: "DRUM", family: "packaging", baseFactor: 1, aliases: ["drum", "drums"] },
  { canonical: "SHEET", family: "packaging", baseFactor: 1, aliases: ["sheet", "sheets"] },

  // --- Electrical: context-dependent scope units, never cross-convertible. ---
  { canonical: "POINT", family: "electrical", baseFactor: 1, aliases: ["point", "points", "pt"] },
  { canonical: "CIRCUIT", family: "electrical", baseFactor: 1, aliases: ["circuit", "circuits", "ckt"] },
  { canonical: "FIXTURE", family: "electrical", baseFactor: 1, aliases: ["fixture", "fixtures"] },

  // --- Mechanical (base: kW) - real physical capacity conversions. ---
  { canonical: "KW", family: "mechanical", baseFactor: 1, aliases: ["kw", "kilowatt", "kilowatts"] },
  { canonical: "HP", family: "mechanical", baseFactor: 0.7457, aliases: ["hp", "horsepower"] },
  { canonical: "TR", family: "mechanical", baseFactor: 3.5168, aliases: ["tr", "tonrefrigeration", "tonsrefrigeration"] }
];

/** Families where every member shares one real physical dimension, so any pair within the
 *  family converts via a baseFactor ratio. Count/packaging/electrical are deliberately
 *  excluded - their units are nominal/discrete and not universally interchangeable. */
const DIMENSIONALLY_CONVERTIBLE_FAMILIES = new Set<UnitFamily>(["length", "area", "volume", "weight", "mechanical"]);

/** Explicit, individually-justified conversions that fall outside the generic
 *  same-family-baseFactor model (e.g. a pair is, by definition, exactly two individual items). */
const SPECIAL_CONVERSIONS: Record<string, Record<string, number>> = {
  PAIR: { NOS: 2 },
  NOS: { PAIR: 0.5 }
};

const ROUNDING_DECIMALS = 6;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class UOMEngine implements IUOMEngine {
  private readonly aliasMap: Map<string, UOMDefinition>;

  constructor() {
    this.aliasMap = this.buildAliasMap();
  }

  private buildAliasMap(): Map<string, UOMDefinition> {
    const map = new Map<string, UOMDefinition>();
    for (const def of UOM_DEFINITIONS) {
      for (const alias of def.aliases) {
        map.set(alias, def);
      }
    }
    return map;
  }

  private toMatchKey(raw: string): string {
    return (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  private resolve(rawUOM: string): UOMDefinition | undefined {
    return this.aliasMap.get(this.toMatchKey(rawUOM));
  }

  private round(value: number): number {
    const factor = 10 ** ROUNDING_DECIMALS;
    return Math.round(value * factor) / factor;
  }

  normalize(uom: string): string {
    const def = this.resolve(uom);
    return def ? def.canonical : (uom ?? "").trim().toUpperCase();
  }

  detectUnitFamily(uom: string): UnitFamily {
    return this.resolve(uom)?.family ?? "unknown";
  }

  areCompatible(fromUOM: string, toUOM: string): boolean {
    return this.convert(fromUOM, toUOM).compatible;
  }

  convert(fromUOM: string, toUOM: string, quantity: number = 1): UOMConversionResult {
    const originalUOM = fromUOM;
    const fromDef = this.resolve(fromUOM);
    const toDef = this.resolve(toUOM);
    const normalizedUOM = fromDef ? fromDef.canonical : this.normalize(fromUOM);

    if (!fromDef || !toDef) {
      return { originalUOM, normalizedUOM, convertedQuantity: quantity, conversionApplied: false, compatible: false };
    }

    if (fromDef.canonical === toDef.canonical) {
      return {
        originalUOM,
        normalizedUOM,
        convertedQuantity: quantity,
        conversionFactor: 1,
        conversionApplied: false,
        compatible: true
      };
    }

    const special = SPECIAL_CONVERSIONS[fromDef.canonical]?.[toDef.canonical];
    if (special !== undefined) {
      return {
        originalUOM,
        normalizedUOM,
        convertedQuantity: this.round(quantity * special),
        conversionFactor: special,
        conversionApplied: true,
        compatible: true
      };
    }

    if (fromDef.family === toDef.family && DIMENSIONALLY_CONVERTIBLE_FAMILIES.has(fromDef.family)) {
      const factor = fromDef.baseFactor / toDef.baseFactor;
      return {
        originalUOM,
        normalizedUOM,
        convertedQuantity: this.round(quantity * factor),
        conversionFactor: this.round(factor),
        conversionApplied: true,
        compatible: true
      };
    }

    // Never convert incompatible units: different families (e.g. NOS -> SQM), or a same
    // family that is not dimensionally convertible (e.g. BAG -> BOX), or SET (no universal size).
    return { originalUOM, normalizedUOM, convertedQuantity: quantity, conversionApplied: false, compatible: false };
  }

  analyzeEngineeringItem(query: UOMAnalysisQuery): UOMConversionResult {
    const sourceUOM = query.engineeringItem.commercial.uom ?? "";
    const sourceQuantity = query.engineeringItem.commercial.quantity ?? 1;

    if (query.historicalMatch) {
      return this.convert(sourceUOM, query.historicalMatch.historicalUOM, sourceQuantity);
    }

    // basicRateMatch carries no UOM on the frozen BasicRateEngine's output - nothing to
    // convert against, so the item's own unit is simply normalized/validated.
    return this.convert(sourceUOM, sourceUOM, sourceQuantity);
  }
}
