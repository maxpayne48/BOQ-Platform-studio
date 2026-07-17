/**
 * EngineeringParser (implemented)
 *
 * Converts an unstructured BOQ line-item description into a structured EngineeringItem.
 * Pure and stateless - no persistence, no I/O, no dependency on any other engine. Meant
 * to be reusable by both Historical BOQ Upload and New RFQ Upload (this pass connects it,
 * read-only, to both) so that every future engine can consume the parsed object instead
 * of re-parsing the raw description itself.
 *
 * Scope boundary (deliberate): no recommendation, no historical-project search, no rate
 * calculation, no recommendation confidence. The only "confidence" here is *parsing*
 * confidence - how much of the description this parser was able to structure.
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface EngineeringParseInput {
  originalDescription: string;
  worksheetName?: string;
  uom?: string;
  quantity?: number;
  rate?: number;
  amount?: number;
  /** True when `rate` came from a basic-rate/material-price sheet rather than a full BOQ row. */
  isBasicRate?: boolean;
}

// ---------------------------------------------------------------------------
// Output - EngineeringItem, sectioned exactly as specified
// ---------------------------------------------------------------------------

export interface EngineeringItemGeneral {
  originalDescription: string;
  normalizedDescription: string;
  canonicalDescription: string;
}

export interface EngineeringItemClassification {
  domain?: string;
  category?: string;
  subcategory?: string;
  activity?: string;
}

export interface EngineeringItemMaterial {
  material?: string;
  materialType?: string;
  brand?: string;
  grade?: string;
  finish?: string;
}

export interface EngineeringItemSpecifications {
  thickness?: number;
  length?: number;
  width?: number;
  height?: number;
  diameter?: number;
  capacity?: number;
  voltage?: number;
  pressureRating?: number;
  strengthClass?: string;
}

export interface EngineeringItemExecution {
  installationMethod?: string;
  constructionMethod?: string;
  locationOfWork?: string;
  floor?: string;
  indoorOutdoor?: "Indoor" | "Outdoor" | "Both";
}

export interface EngineeringItemCommercial {
  uom?: string;
  quantity?: number;
  historicalRate?: number;
  basicRate?: number;
  amount?: number;
}

export interface EngineeringItemSearch {
  keywords: string[];
  synonyms: string[];
  stemmedTokens: string[];
}

export interface EngineeringItemValidation {
  confidence: number; // 0-100, parsing confidence only
  missingAttributes: string[];
  ambiguousAttributes: string[];
  unknownTerms: string[];
}

export interface EngineeringItem {
  general: EngineeringItemGeneral;
  classification: EngineeringItemClassification;
  material: EngineeringItemMaterial;
  specifications: EngineeringItemSpecifications;
  execution: EngineeringItemExecution;
  commercial: EngineeringItemCommercial;
  search: EngineeringItemSearch;
  validation: EngineeringItemValidation;
}

/**
 * Legacy, flatter dimension bag kept only so backend/src/engines/UOMEngine.ts and
 * backend/src/engines/KnowledgeBaseEngine.ts (both frozen this pass) keep compiling
 * against their existing `import type { EngineeringDimensions }` - neither calls a method
 * to produce one, they only reference the shape, so widening it here is safe. All of its
 * original optional fields are preserved unchanged; nothing was removed.
 */
export interface EngineeringDimensions {
  thickness?: number;
  diameter?: number;
  capacity?: number;
  width?: number;
  height?: number;
  voltage?: number;
  pipeDiameter?: number;
  grade?: string;
  mixRatio?: string;
  brand?: string;
  finish?: string;
}

/** Bridges the new, richer specification set back to the legacy flat shape above. */
export function toEngineeringDimensions(item: EngineeringItem): EngineeringDimensions {
  return {
    thickness: item.specifications.thickness,
    diameter: item.specifications.diameter,
    capacity: item.specifications.capacity,
    width: item.specifications.width,
    height: item.specifications.height,
    voltage: item.specifications.voltage,
    grade: item.material.grade,
    brand: item.material.brand,
    finish: item.material.finish
  };
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface IEngineeringParser {
  parse(input: EngineeringParseInput): EngineeringItem;
}

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------

const ABBREVIATION_EXPANSIONS: Record<string, string> = {
  gyp: "gypsum",
  brd: "board",
  thk: "thick",
  dia: "diameter",
  nos: "number",
  qty: "quantity",
  reinf: "reinforced",
  ms: "mild steel",
  ss: "stainless steel",
  rcc: "reinforced cement concrete",
  pcc: "plain cement concrete",
  gi: "galvanized iron",
  ply: "plywood",
  lam: "laminate",
  alum: "aluminium",
  elec: "electrical",
  mech: "mechanical",
  sqm: "square metre",
  sqft: "square feet",
  cum: "cubic metre",
  cft: "cubic feet",
  rmt: "running metre"
};

const STOPWORDS = new Set([
  "the", "and", "of", "for", "with", "to", "in", "on", "a", "an", "as",
  "at", "by", "from", "or", "is", "are", "this", "that", "providing", "fixing"
]);

const SYNONYM_GROUPS: string[][] = [
  ["ms", "mild", "steel"],
  ["ss", "stainless", "steel"],
  ["rcc", "reinforced", "cement", "concrete"],
  ["pcc", "plain", "cement", "concrete"],
  ["gi", "galvanized", "iron"],
  ["ply", "plywood"],
  ["lam", "laminate"],
  ["gyp", "gypsum"],
  ["sqm", "square", "metre", "meter"],
  ["sqft", "sft", "square", "feet", "foot"],
  ["cum", "cubic", "metre", "meter"],
  ["cft", "cubic", "feet", "foot"],
  ["rmt", "running", "metre", "meter"]
];

const STEM_SUFFIXES = ["ing", "edly", "ed", "ies", "es", "ly", "s"];

const DOMAIN_KEYWORDS: Array<{ domain: string; pattern: RegExp }> = [
  { domain: "Civil", pattern: /\bcivil\b/i },
  { domain: "Interior", pattern: /\b(interior|fit\s*-?out|furniture|joinery)\b/i },
  { domain: "Electrical", pattern: /\b(electrical|elec|power|lighting)\b/i },
  { domain: "Mechanical", pattern: /\b(mechanical|hvac|plumbing|phe|fire\s*fighting)\b/i }
];

const ACTIVITY_KEYWORDS: Record<string, RegExp> = {
  Supply: /\bsupply\b/i,
  Fixing: /\bfix(ed|ing)?\b/i,
  Laying: /\blay(ing|ed)?\b/i,
  Installation: /\binstall(ation)?\b/i,
  Excavation: /\bexcavat/i,
  Concreting: /\bconcret/i,
  Painting: /\bpaint(ing)?\b/i,
  Plastering: /\bplaster(ing)?\b/i,
  Wiring: /\b(wiring|cabling)\b/i,
  Plumbing: /\bplumb(ing)?\b/i
};

const CATEGORY_KEYWORDS: Record<string, RegExp> = {
  // Requires the work-trade sense ("flooring", "floor tile/finish/screed") - a bare
  // "floor" almost always refers to a building level ("ground floor") in real BOQ text,
  // not the flooring trade, so it deliberately does not match on its own.
  Flooring: /\bfloor(ing)\b|\bfloor\s+(tiles?|finish|screed)\b/i,
  Ceiling: /\bceiling\b/i,
  Walling: /\b(wall|partition)\b/i,
  "Painting Works": /\bpaint(ing)?\b/i,
  "Electrical Fittings": /\b(switch|socket|wiring|cabling|light(ing)?|fixture)\b/i,
  "Plumbing Fixtures": /\b(pipe|plumb(ing)?|sanitary|faucet|tap)\b/i,
  "Doors & Windows": /\b(door|window)\b/i,
  Furniture: /\b(furniture|cabinet|joinery)\b/i
};

interface MaterialDefinition {
  label: string;
  materialType: string;
  thicknessImplied: boolean;
  pattern: RegExp;
}

const MATERIAL_DICTIONARY: MaterialDefinition[] = [
  { label: "Gypsum Board", materialType: "Board", thicknessImplied: true, pattern: /\bgypsum\s+boards?\b/i },
  { label: "Plywood", materialType: "Wood", thicknessImplied: true, pattern: /\bply\s*woods?\b/i },
  { label: "Laminate", materialType: "Wood Finish", thicknessImplied: true, pattern: /\blaminates?\b/i },
  { label: "Granite", materialType: "Stone", thicknessImplied: true, pattern: /\bgranites?\b/i },
  { label: "Marble", materialType: "Stone", thicknessImplied: true, pattern: /\bmarbles?\b/i },
  { label: "Vitrified Tile", materialType: "Tile", thicknessImplied: true, pattern: /\bvitrified(\s+tiles?)?\b/i },
  { label: "Acrylic Sheet", materialType: "Plastic", thicknessImplied: true, pattern: /\bacrylic(\s+sheets?)?\b/i },
  { label: "Glass", materialType: "Glass", thicknessImplied: true, pattern: /\bglass\b/i },
  { label: "Mild Steel", materialType: "Metal", thicknessImplied: false, pattern: /\b(mild\s+steel)\b/i },
  { label: "Stainless Steel", materialType: "Metal", thicknessImplied: false, pattern: /\b(stainless\s+steel)\b/i },
  { label: "Aluminium", materialType: "Metal", thicknessImplied: false, pattern: /\b(aluminium|aluminum)\b/i },
  { label: "Copper", materialType: "Metal", thicknessImplied: false, pattern: /\bcopper\b/i },
  {
    label: "Concrete",
    materialType: "Concrete",
    thicknessImplied: false,
    pattern: /\b(concrete|reinforced\s+cement\s+concrete|plain\s+cement\s+concrete)\b/i
  },
  { label: "PVC", materialType: "Plastic", thicknessImplied: false, pattern: /\bpvc\b/i },
  { label: "GI Pipe", materialType: "Metal", thicknessImplied: false, pattern: /\b(galvanized\s+iron\s+pipe|gi\s+pipe)\b/i },
  { label: "Wood", materialType: "Wood", thicknessImplied: false, pattern: /\bwood(en)?\b/i }
];

const PRODUCT_GRADE_KEYWORDS = [
  "Moisture Resistant", "Fire Rated", "Fire Resistant", "Water Resistant",
  "Weather Resistant", "Heavy Duty", "Marine Grade", "Exterior Grade", "Interior Grade",
  "Premium", "Standard"
];

const COLOR_KEYWORDS = [
  "Green", "White", "Black", "Grey", "Gray", "Beige", "Brown", "Red", "Blue",
  "Ivory", "Cream", "Yellow", "Natural", "Off-White"
];

const FINISH_TEXTURE_KEYWORDS = ["Matte", "Matt", "Glossy", "Gloss", "Polished", "Satin", "Textured"];

const KNOWN_BRANDS = [
  "Asian Paints", "Hettich", "Kohler", "Jaguar", "Grohe", "Hafele",
  "Godrej", "Havells", "Legrand", "Schneider", "Saint-Gobain", "Gyproc", "USG Boral"
];

const INSTALLATION_METHOD_KEYWORDS: Record<string, RegExp> = {
  Bolted: /\bbolt(ed|ing)?\b/i,
  Welded: /\bweld(ed|ing)?\b/i,
  Screwed: /\bscrew(ed|ing)?\b/i,
  Bonded: /\b(bond(ed|ing)?|glu(e|ed|ing))\b/i,
  Recessed: /\brecess(ed)?\b/i,
  "Surface Mounted": /\bsurface\s*mount(ed)?\b/i,
  Concealed: /\bconceal(ed)?\b/i,
  Laid: /\blaid\b/i,
  Fixed: /\bfix(ed|ing)?\b/i
};

const CONSTRUCTION_METHOD_KEYWORDS: Record<string, RegExp> = {
  "Cast in-situ": /\bcast[\s-]*in[\s-]*situ\b/i,
  Precast: /\bprecast\b/i,
  Prefabricated: /\bprefab(ricated)?\b/i,
  "Site-fabricated": /\bsite[\s-]*fabricat(ed)?\b/i
};

const LOCATION_KEYWORDS = [
  "Toilet", "Washroom", "Lobby", "Basement", "Terrace", "Facade", "Corridor",
  "Staircase", "Parking", "Kitchen", "Pantry", "Reception", "Cabin", "Server Room"
];

const FLOOR_PATTERN = /\b((?:ground|first|second|third|fourth|fifth)\s*floor|\d+(?:st|nd|rd|th)\s*floor|\bgf\b|\bb\d\b|basement\s*\d*)\b/i;

const INDOOR_PATTERN = /\b(internal|interior|indoor)\b/i;
const OUTDOOR_PATTERN = /\b(external|exterior|outdoor|facade)\b/i;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class EngineeringParser implements IEngineeringParser {
  parse(input: EngineeringParseInput): EngineeringItem {
    const original = input.originalDescription ?? "";
    const normalized = this.normalize(original);

    const domain = this.detectDomain(input.worksheetName, normalized);
    const activity = this.extractFirstMatch(normalized, ACTIVITY_KEYWORDS);
    const category = this.extractFirstMatch(normalized, CATEGORY_KEYWORDS);

    const materialMatches = this.findAllMaterialMatches(normalized);
    const primaryMaterial = materialMatches[0];
    const material = primaryMaterial?.label;
    const materialType = primaryMaterial?.materialType;
    const subcategory = [material, category].filter(Boolean).join(" ") || undefined;

    const brand = KNOWN_BRANDS.find((b) => normalized.toLowerCase().includes(b.toLowerCase()));

    const gradeMatches = PRODUCT_GRADE_KEYWORDS.filter((g) => new RegExp(`\\b${g}\\b`, "i").test(normalized));
    const grade = gradeMatches[0];

    const colorMatch = COLOR_KEYWORDS.find((c) => new RegExp(`\\b${c}\\b`, "i").test(normalized));
    const textureMatch = FINISH_TEXTURE_KEYWORDS.find((f) => new RegExp(`\\b${f}\\b`, "i").test(normalized));
    const finish = [textureMatch, colorMatch].filter(Boolean).join(" ") || undefined;

    const specs = this.extractSpecifications(normalized, primaryMaterial);

    const installationMethod = this.extractFirstMatch(normalized, INSTALLATION_METHOD_KEYWORDS);
    const constructionMethod = this.extractFirstMatch(normalized, CONSTRUCTION_METHOD_KEYWORDS);
    const locationOfWork = LOCATION_KEYWORDS.find((loc) => normalized.toLowerCase().includes(loc.toLowerCase()));
    const floorMatch = normalized.match(FLOOR_PATTERN);
    const floor = floorMatch ? floorMatch[1] : undefined;
    const isIndoor = INDOOR_PATTERN.test(normalized);
    const isOutdoor = OUTDOOR_PATTERN.test(normalized);
    const indoorOutdoor = isIndoor && isOutdoor ? "Both" : isIndoor ? "Indoor" : isOutdoor ? "Outdoor" : undefined;

    const canonicalDescription = this.buildCanonicalDescription(material, specs, grade, finish, brand);

    const keywords = this.extractKeywords(normalized);
    const synonyms = this.expandSynonyms(keywords).filter((t) => !keywords.includes(t));
    const stemmedTokens = this.stemTokens(keywords);

    const item: EngineeringItem = {
      general: {
        originalDescription: original,
        normalizedDescription: normalized.toLowerCase(),
        canonicalDescription
      },
      classification: { domain, category, subcategory, activity },
      material: { material, materialType, brand, grade, finish },
      specifications: specs,
      execution: { installationMethod, constructionMethod, locationOfWork, floor, indoorOutdoor },
      commercial: {
        uom: input.uom,
        quantity: input.quantity,
        historicalRate: input.isBasicRate ? undefined : input.rate,
        basicRate: input.isBasicRate ? input.rate : undefined,
        amount: input.amount
      },
      search: { keywords, synonyms, stemmedTokens },
      validation: { confidence: 0, missingAttributes: [], ambiguousAttributes: [], unknownTerms: [] }
    };

    item.validation = this.validate(item, materialMatches, gradeMatches, normalized);
    return item;
  }

  // --- Normalization --------------------------------------------------------

  private normalize(description: string): string {
    let text = description ?? "";

    // "12 mm" -> "12mm" (unify spaced and unspaced number+unit forms)
    text = text.replace(/(\d+(?:\.\d+)?)\s+(mm|cm|kg|ltr|kva|hp|watt|volt|v|w)\b/gi, "$1$2");

    text = text.replace(/\s+/g, " ").trim();

    // Whole-token abbreviation expansion (never touches number+unit tokens like "12mm").
    text = text
      .split(" ")
      .map((word) => {
        const bare = word.replace(/[^a-zA-Z]/g, "").toLowerCase();
        const expansion = ABBREVIATION_EXPANSIONS[bare];
        return expansion ?? word;
      })
      .join(" ");

    return text;
  }

  private extractFirstMatch(text: string, dictionary: Record<string, RegExp>): string | undefined {
    for (const [label, pattern] of Object.entries(dictionary)) {
      if (pattern.test(text)) return label;
    }
    return undefined;
  }

  private findAllMaterialMatches(text: string): MaterialDefinition[] {
    return MATERIAL_DICTIONARY.filter((def) => def.pattern.test(text));
  }

  // --- Specifications ---------------------------------------------------

  private extractSpecifications(text: string, materialContext: MaterialDefinition | undefined): EngineeringItemSpecifications {
    const specs: EngineeringItemSpecifications = {};

    const explicitThickness =
      text.match(/(\d+(?:\.\d+)?)mm\s*(?:thk\.?|thick)/i) || text.match(/(?:thk\.?|thickness)\s*[:\-]?\s*(\d+(?:\.\d+)?)mm/i);
    if (explicitThickness) specs.thickness = parseFloat(explicitThickness[1]);

    const explicitDiameter =
      text.match(/(?:dia\.?|diameter)\s*[:\-]?\s*(\d+(?:\.\d+)?)mm/i) ||
      text.match(/(\d+(?:\.\d+)?)mm\s*dia\.?/i) ||
      text.match(/\bDN\s?(\d+(?:\.\d+)?)\b/i);
    if (explicitDiameter) specs.diameter = parseFloat(explicitDiameter[1]);

    const threeDimMatch = text.match(
      /(\d+(?:\.\d+)?)\s*(?:mm|cm)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:mm|cm)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:mm|cm)?/i
    );
    const twoDimMatch = !threeDimMatch && text.match(/(\d+(?:\.\d+)?)\s*(?:mm|cm)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:mm|cm)?/i);

    if (threeDimMatch) {
      specs.length = parseFloat(threeDimMatch[1]);
      specs.width = parseFloat(threeDimMatch[2]);
      if (specs.thickness === undefined) specs.thickness = parseFloat(threeDimMatch[3]);
      else specs.height = parseFloat(threeDimMatch[3]);
    } else if (twoDimMatch) {
      specs.width = parseFloat(twoDimMatch[1]);
      specs.height = parseFloat(twoDimMatch[2]);
    }

    if (specs.thickness === undefined && specs.diameter === undefined && materialContext?.thicknessImplied) {
      const bareMm = text.match(/\b(\d+(?:\.\d+)?)mm\b/i);
      if (bareMm) specs.thickness = parseFloat(bareMm[1]);
    }

    const lengthMatch = text.match(/(\d+(?:\.\d+)?)mm\s*long\b/i) || text.match(/length\s*[:\-]?\s*(\d+(?:\.\d+)?)mm/i);
    if (lengthMatch && specs.length === undefined) specs.length = parseFloat(lengthMatch[1]);

    const capacityMatch = text.match(/(\d+(?:\.\d+)?)\s*(watt|watts|w|ton|tr|kva|hp)\b/i);
    if (capacityMatch) specs.capacity = parseFloat(capacityMatch[1]);

    const voltageMatch = text.match(/(\d+(?:\.\d+)?)\s*(kv|kilovolt|v|volt|volts)\b/i);
    if (voltageMatch) {
      const raw = parseFloat(voltageMatch[1]);
      specs.voltage = /kv|kilovolt/i.test(voltageMatch[2]) ? raw * 1000 : raw;
    }

    const pressureMatch = text.match(/\bpn\s?(\d+(?:\.\d+)?)\b/i) || text.match(/(\d+(?:\.\d+)?)\s*(bar|kg\/cm2|psi)\b/i);
    if (pressureMatch) specs.pressureRating = parseFloat(pressureMatch[1]);

    const strengthMatch = text.match(/\b(M\s?\d{2}|Fe\s?\d{3})\b/i);
    if (strengthMatch) specs.strengthClass = strengthMatch[1].toUpperCase().replace(/\s+/g, "");

    return specs;
  }

  // --- Canonicalization -------------------------------------------------

  private buildCanonicalDescription(
    material: string | undefined,
    specs: EngineeringItemSpecifications,
    grade: string | undefined,
    finish: string | undefined,
    brand: string | undefined
  ): string {
    const parts: string[] = [];
    if (material) parts.push(material);

    if (specs.thickness !== undefined) parts.push(`${specs.thickness}mm`);
    if (specs.length !== undefined && specs.width !== undefined) {
      parts.push(`${specs.length}x${specs.width}mm`);
    } else if (specs.width !== undefined && specs.height !== undefined) {
      parts.push(`${specs.width}x${specs.height}mm`);
    }
    if (specs.diameter !== undefined) parts.push(`${specs.diameter}mm dia`);
    if (specs.strengthClass) parts.push(specs.strengthClass);
    if (grade) parts.push(grade);
    if (finish) parts.push(finish);
    if (brand) parts.push(brand);

    return parts.join(" ") || material || "Unclassified Item";
  }

  // --- Domain -------------------------------------------------------------

  private detectDomain(worksheetName: string | undefined, description: string): string | undefined {
    if (worksheetName) {
      for (const { domain, pattern } of DOMAIN_KEYWORDS) {
        if (pattern.test(worksheetName)) return domain;
      }
    }
    for (const { domain, pattern } of DOMAIN_KEYWORDS) {
      if (pattern.test(description)) return domain;
    }
    return undefined;
  }

  // --- Search metadata --------------------------------------------------

  private extractKeywords(text: string): string[] {
    const cleaned = (text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const filtered = tokens.filter((token) => token.length > 2 && !STOPWORDS.has(token));
    return Array.from(new Set(filtered));
  }

  private expandSynonyms(tokens: string[]): string[] {
    const expanded = new Set(tokens);
    for (const token of tokens) {
      const synonyms = this.synonymDictionary.get(token);
      if (synonyms) synonyms.forEach((s) => expanded.add(s));
    }
    return Array.from(expanded);
  }

  private readonly synonymDictionary = this.buildSynonymDictionary();

  private buildSynonymDictionary(): Map<string, Set<string>> {
    const dictionary = new Map<string, Set<string>>();
    for (const group of SYNONYM_GROUPS) {
      for (const token of group) {
        const set = dictionary.get(token) ?? new Set<string>();
        for (const other of group) {
          if (other !== token) set.add(other);
        }
        dictionary.set(token, set);
      }
    }
    return dictionary;
  }

  private stem(token: string): string {
    for (const suffix of STEM_SUFFIXES) {
      if (token.length - suffix.length >= 3 && token.endsWith(suffix)) {
        return token.slice(0, -suffix.length);
      }
    }
    return token;
  }

  private stemTokens(tokens: string[]): string[] {
    return Array.from(new Set(tokens.map((token) => this.stem(token))));
  }

  // --- Validation ---------------------------------------------------------

  private validate(
    item: EngineeringItem,
    materialMatches: MaterialDefinition[],
    gradeMatches: string[],
    normalizedText: string
  ): EngineeringItemValidation {
    const missingAttributes: string[] = [];
    if (!item.material.material) missingAttributes.push("material");
    if (!item.classification.category) missingAttributes.push("category");
    if (!item.classification.activity) missingAttributes.push("activity");
    if (!item.commercial.uom) missingAttributes.push("uom");

    const hasAnySpec = Object.values(item.specifications).some((v) => v !== undefined);
    if (!hasAnySpec) missingAttributes.push("specifications");

    const hasExecutionInfo = Boolean(item.execution.installationMethod || item.execution.constructionMethod);
    if (!hasExecutionInfo) missingAttributes.push("execution");

    const ambiguousAttributes: string[] = [];
    if (materialMatches.length > 1) ambiguousAttributes.push("material");
    if (gradeMatches.length > 1) ambiguousAttributes.push("grade");

    const unknownTerms = this.findUnknownTerms(normalizedText, item);

    const checklistSize = 6;
    const confidence = Math.round(((checklistSize - missingAttributes.length) / checklistSize) * 100);

    return { confidence, missingAttributes, ambiguousAttributes, unknownTerms };
  }

  /** Alphanumeric-looking tokens (likely product/spec codes) that no extraction rule consumed. */
  private findUnknownTerms(text: string, item: EngineeringItem): string[] {
    const consumedNumbers = new Set(
      Object.values(item.specifications)
        .filter((v): v is number => typeof v === "number")
        .map((v) => String(v))
    );

    const consumedStringFields = [
      item.material.material,
      item.material.grade,
      item.material.brand,
      item.material.finish,
      item.specifications.strengthClass,
      item.classification.category,
      item.classification.activity
    ]
      .filter((v): v is string => Boolean(v))
      .join(" ")
      .toLowerCase();

    const candidateTokens = text.match(/\b[a-zA-Z]*\d+[a-zA-Z]*\b/g) ?? [];
    const unknown = candidateTokens.filter((token) => {
      if (consumedStringFields.includes(token.toLowerCase())) return false;
      const digits = token.match(/\d+/)?.[0];
      if (digits && consumedNumbers.has(digits)) return false;
      if (/^\d+mm$/i.test(token) && item.specifications.thickness !== undefined) return false;
      return true;
    });

    return Array.from(new Set(unknown));
  }
}
