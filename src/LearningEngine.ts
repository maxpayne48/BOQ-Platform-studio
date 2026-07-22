import { LearningEvent } from "./types.js";

// Learning Layer - the recommendation engine's mechanism for improving automatically as more
// historical BOQs and estimator corrections accumulate, without ever being manually retrained.
// Every time an estimator overrides a recommendation (POST /api/rfqs/:id/override), a
// LearningEvent is appended to a permanent log. This module analyzes that log - indexed once per
// analysis, never re-scanned per item - to detect three patterns, then hands a small, bounded,
// confidence-scaled bias correction back to ProjectCalibrationEngine ("gradually incorporate",
// never a blind override of the statistical market rate).

const MIN_EVENTS_FOR_DOMAIN_BIAS = 3;
const MIN_EVENTS_FOR_FREQUENT_ITEM = 2;
const MIN_EVENTS_FOR_MATERIAL_INSTABILITY = 3;
const MAX_LEARNED_BIAS_ADJUSTMENT = 0.10; // never nudge a rate by more than +-10%, no matter how
// strong the learned signal - this stays a gradual correction, not a replacement for the
// statistical market rate.
const BIAS_CONFIDENCE_SATURATION_EVENTS = 10; // event count at which a learned bias is trusted at
// full strength; below this it's scaled down proportionally (the engine only gets more confident
// - and only nudges harder - as more corrections accumulate).

export interface DomainBiasInsight {
  domain: string;
  eventCount: number;
  averagePercentDiff: number; // signed - e.g. +8.2 means estimators consistently raise this domain
  consistency: number; // 0-100 - what fraction of corrections shared the average's direction
}

export interface FrequentlyCorrectedItem {
  masterId: string;
  description: string;
  correctionCount: number;
  averagePercentDiff: number;
}

export interface MaterialInstability {
  material: string;
  eventCount: number;
  percentDiffStdDev: number; // high = corrections for this material are inconsistent/unpredictable
}

export interface LearningAnalysis {
  totalEvents: number;
  domainBias: DomainBiasInsight[];
  frequentlyCorrectedItems: FrequentlyCorrectedItem[];
  materialInstability: MaterialInstability[];
}

function stdDev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function analyzeLearningEvents(events: LearningEvent[]): LearningAnalysis {
  // Single pass to build all three indexes at once - no brute-force re-scanning of the event log
  // per domain/item/material.
  const byDomain = new Map<string, LearningEvent[]>();
  const byMaster = new Map<string, LearningEvent[]>();
  const byMaterial = new Map<string, LearningEvent[]>();

  for (const e of events) {
    if (!byDomain.has(e.domain)) byDomain.set(e.domain, []);
    byDomain.get(e.domain)!.push(e);

    if (e.masterId) {
      if (!byMaster.has(e.masterId)) byMaster.set(e.masterId, []);
      byMaster.get(e.masterId)!.push(e);
    }

    if (e.material) {
      const key = e.material.toLowerCase().trim();
      if (key) {
        if (!byMaterial.has(key)) byMaterial.set(key, []);
        byMaterial.get(key)!.push(e);
      }
    }
  }

  const domainBias: DomainBiasInsight[] = [];
  for (const [domain, evs] of byDomain.entries()) {
    if (evs.length < MIN_EVENTS_FOR_DOMAIN_BIAS) continue;
    const diffs = evs.map((e) => e.differencePercent);
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sameSignCount = diffs.filter((d) => Math.sign(d) === Math.sign(avg) || Math.abs(d) < 0.01).length;
    domainBias.push({
      domain,
      eventCount: evs.length,
      averagePercentDiff: Math.round(avg * 10) / 10,
      consistency: Math.round((sameSignCount / diffs.length) * 100)
    });
  }

  const frequentlyCorrectedItems: FrequentlyCorrectedItem[] = [];
  for (const [masterId, evs] of byMaster.entries()) {
    if (evs.length < MIN_EVENTS_FOR_FREQUENT_ITEM) continue;
    const diffs = evs.map((e) => e.differencePercent);
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    frequentlyCorrectedItems.push({
      masterId,
      description: evs[evs.length - 1].itemDescription,
      correctionCount: evs.length,
      averagePercentDiff: Math.round(avg * 10) / 10
    });
  }
  frequentlyCorrectedItems.sort((a, b) => b.correctionCount - a.correctionCount);

  const materialInstability: MaterialInstability[] = [];
  for (const [material, evs] of byMaterial.entries()) {
    if (evs.length < MIN_EVENTS_FOR_MATERIAL_INSTABILITY) continue;
    const diffs = evs.map((e) => e.differencePercent);
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    materialInstability.push({
      material,
      eventCount: evs.length,
      percentDiffStdDev: Math.round(stdDev(diffs, mean) * 10) / 10
    });
  }
  materialInstability.sort((a, b) => b.percentDiffStdDev - a.percentDiffStdDev);

  return { totalEvents: events.length, domainBias, frequentlyCorrectedItems, materialInstability };
}

// Caching: the event log is append-only, so the event COUNT is a cheap, correct cache key -
// re-analysis (already a single O(N) pass) only happens when new learning events have actually
// been recorded since the last call, not on every /recommend invocation.
let cachedAnalysis: LearningAnalysis | null = null;
let cachedEventCount = -1;

function getLearningAnalysis(events: LearningEvent[]): LearningAnalysis {
  if (cachedAnalysis && cachedEventCount === events.length) return cachedAnalysis;
  cachedAnalysis = analyzeLearningEvents(events);
  cachedEventCount = events.length;
  return cachedAnalysis;
}

export interface LearnedBiasResult {
  adjustmentFactor: number; // signed fraction, e.g. 0.04 = +4%, bounded to +-MAX_LEARNED_BIAS_ADJUSTMENT
  reason: string | null;
}

function getLearnedBiasAdjustment(domain: string, masterId: string | undefined, analysis: LearningAnalysis): LearnedBiasResult {
  // An item-specific correction history is a more precise signal than a domain-wide one - prefer
  // it when available.
  const itemBias = masterId ? analysis.frequentlyCorrectedItems.find((f) => f.masterId === masterId) : undefined;
  const domainBias = analysis.domainBias.find((d) => d.domain === domain);

  if (!itemBias && !domainBias) return { adjustmentFactor: 0, reason: null };

  const percentDiff = itemBias ? itemBias.averagePercentDiff : (domainBias as DomainBiasInsight).averagePercentDiff;
  const eventCount = itemBias ? itemBias.correctionCount : (domainBias as DomainBiasInsight).eventCount;
  const consistency = itemBias ? 1 : (domainBias as DomainBiasInsight).consistency / 100;

  // Gradually incorporate: confidence scales with how much evidence exists (more corrections ->
  // more trust) and how consistent their direction is (a domain corrected up half the time and
  // down half the time has no real bias to apply, no matter how many events accumulate).
  const dataConfidence = Math.min(1, eventCount / BIAS_CONFIDENCE_SATURATION_EVENTS);
  const rawFactor = (percentDiff / 100) * dataConfidence * consistency;
  const adjustmentFactor = Math.max(-MAX_LEARNED_BIAS_ADJUSTMENT, Math.min(MAX_LEARNED_BIAS_ADJUSTMENT, rawFactor));

  if (Math.abs(adjustmentFactor) < 0.01) return { adjustmentFactor: 0, reason: null };

  const reason = itemBias
    ? `Learned bias: estimators corrected this exact item ${eventCount} time(s), averaging ${percentDiff > 0 ? "+" : ""}${percentDiff.toFixed(1)}%.`
    : `Learned bias: "${domain}" has been consistently corrected (${eventCount} corrections, ${Math.round(consistency * 100)}% consistent direction, averaging ${percentDiff > 0 ? "+" : ""}${percentDiff.toFixed(1)}%).`;

  return { adjustmentFactor, reason };
}

export const LearningEngine = {
  getLearningAnalysis,
  getLearnedBiasAdjustment
};
