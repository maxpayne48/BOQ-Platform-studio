# Phase 0 — Architectural Audit of the Recommendation Workflow

Date: 2026-07-24
Scope: everything between RFQ upload and export, across `server.ts` (7,012 lines), `src/*.ts` engines, `src/components/RecommendationsTab.tsx` / `DashboardTab.tsx`, and the dormant `backend/src/engines/*` tree.
Method: static trace with file:line citations. No code was changed to produce this document.

---

## 1. Dependency Map (as-built, not as-intended)

```
RFQ Upload  (server.ts POST /api/rfqs, ~3688-3951)
   |
   v
Parser  (src/BOQParserEngine.ts: validateAndSanitizeWorkbook L332-396, parseWorkbookForUpload L398-489)
   |
   v
Master BOQ  (server.ts precomputeMasterItemFields L866-1082, initializeMasterDatabaseAndIndex L1084-1250)
   |  -- NOTE: this is a load-time/admin-time index build, not a per-RFQ step.
   |  -- RFQ items are never merged back into the Master BOQ by the recommend route.
   v
Project Retrieval  (src/RecommendationEngineV2.ts getSimilarProjects L44-99, called once/run at server.ts:4411)
   |
   v
Item Matching  (src/HistoricalRetrievalEngine.ts retrieveRankedHistoricalCandidates L165-342, per item at server.ts:4508-4526)
   |
   v
Specification Matching  (src/EngineeringAdjustmentEngine.ts isCommerciallyEquivalent L170-181;
   |                      specificationSimilarity scoring in HistoricalRetrievalEngine.ts L255-261)
   v
Engineering Understanding  (src/EngineeringAdjustmentEngine.ts computeEngineeringAdjustment L208-367,
   |                        called server.ts:4589-4657)
   v
Historical Evidence  (src/ProjectCalibrationEngine.ts selectHistoricalEvidence L241-366,
   |                   also reused directly by src/ProgressiveMatchingEngine.ts)
   v
Commercial Decision  ***FIVE SEQUENTIAL, INDEPENDENT WRITERS TO THE SAME FIELD*** (see §4)
   |   1. RecommendationEngineV2.recommendItem            (baseline)              server.ts:4487-4493
   |   2. EngineeringAdjustmentEngine.computeEngineeringAdjustment (overwrite)     server.ts:4616
   |   3. ProgressiveMatchingEngine.estimateForUnmatchedItem (overwrite)          server.ts:4666-4688
   |   4. ProjectCalibrationEngine.runProjectCalibration (overwrite, whole-item loop, AFTER #1-3 finish for every item) server.ts:4839-4848
   |   5. Task 8 "self-validation" second pass (overwrite again)                  server.ts:4926-5023
   v
Validation  (server.ts buildItemValidationResults L4778-4830, called twice: L4916 and L5008 -
   |         an INDEPENDENT decision-maker, not derived from item.status)
   v
Confidence  (src/ProjectCalibrationEngine.ts computeItemConfidenceProfile L388-479 -
   |         writes 6 fields that are DIFFERENT from and NEVER reconcile with item.status/confidenceScore)
   v
Dashboard  (src/components/RecommendationsTab.tsx recommendationSummary L462-473 -
   |         an INDEPENDENT re-bucketing of Auto Approved/Needs Review/Manual Pricing;
   |         src/components/DashboardTab.tsx is a pure consumer of /api/analytics)
   v
Auditor  (server.ts replayAuditorReport L5063-5108 - relabels the same status under a 3rd vocabulary
   |       VERIFIED/NEW_ITEM, computes its own replayAccuracy formula)
   v
Export  (server.ts ~5774-6260 - two MORE independent gates: pairedRateViolations L5840,
          Historical Replay Auditor gate L6008-6260 [currently dead - replayDetected never set];
          the live filter at L5819 is a pure consumer of item.status)
```

**A second, fully parallel pipeline exists and is wired into the same server process:**

```
backend/src/engines/*  (KnowledgeBaseEngine, EngineeringParser, ProjectSimilarityEngine,
                        HistoricalRateEngine, BasicRateEngine, UOMEngine, ConfidenceEngine,
                        RecommendationEngineV2 [aliased RecommendationEngineV2New], RecommendationLogger)
   -> wired only to POST /api/rfqs/:id/recommend-v2 (server.ts:5163), never called by any
      frontend component (confirmed: only RecommendationsTab.tsx:163 calls /recommend, the legacy route)
   -> EngineeringParser also runs a fire-and-forget, log-only pass inside setImmediate() on
      POST /api/historical-boqs (server.ts:2521-2549) and POST /api/rfqs (server.ts:4028-4057) -
      writes nothing to any store the legacy path reads, verified side-effect-free.
```

This tree is inert with respect to data flow (no store contamination - see §3), but it independently reimplements the same business concepts (rate calculation, confidence, approval status) under colliding class names. It is an architectural risk, not a data-integrity one.

---

## 2. Every Location Where a Business Decision Is Calculated

| Concept | File | Class/Fn | Lines | Input | Output | Notes |
|---|---|---|---|---|---|---|
| Project Similarity | `src/RecommendationEngineV2.ts` | `getSimilarProjects` | 44-99 | projectCost/size/type/city/grade, `historicalBOQs` | `{project, similarity}[]` top 5 | Weighted: Type 30%, Cost 20%, Size 20%, City 20%, Grade 10%; 30% floor |
| Item/Semantic Similarity | `src/HistoricalRetrievalEngine.ts` | `retrieveRankedHistoricalCandidates` | 165-342 | item, domainFamilyIndex, similarityByProjectName | `{candidates, rejectedCandidates}` | Hard gates: semantic ≥45, UOM compatible, `isCommerciallyEquivalent` |
| Specification Similarity/Equivalence | `src/EngineeringAdjustmentEngine.ts` / `src/HistoricalRetrievalEngine.ts` | `isCommerciallyEquivalent` / inline `specificationSimilarity` | 170-181 / 255-261 | two descriptions | `{equivalent, reason}` / score | Distinguishing-qualifier gate (fire-rated, toughened, etc.) |
| Engineering Adjustment | `src/EngineeringAdjustmentEngine.ts` | `computeEngineeringAdjustment` | 208-367 | itemDescription, fallbackRate, allMasterItems | `EngineeringAdjustmentResult{finalRate, confidence,...}` | Volume/Area/Linear interpolation-extrapolation |
| Historical Evidence Selection | `src/ProjectCalibrationEngine.ts` | `selectHistoricalEvidence` | 241-366 | matchedMaster, candidates, grade, year, domain | `MarketRateStatistics{selectedRate, representativeRate,...}` | Picks single best-match rate, never averages |
| Recommended Rate (baseline) | `src/RecommendationEngineV2.ts` | `recommendItem` | 118-222 | item, masterIndex | `{recommendedRate, confidence, matchedMasterId, trace}` | Master-match => rate direct, no markup; else 5-step build-up |
| Recommended Rate (overwrite #2) | `src/EngineeringAdjustmentEngine.ts` via server.ts | — | server.ts:4616 | adjustment.finalRate | `item.recommendedRate` overwritten | Only if `adjustment.applied` |
| Recommended Rate (overwrite #3) | `src/ProgressiveMatchingEngine.ts` | `estimateForUnmatchedItem` | 66-147 | item, tier ladder | `item.recommendedRate` overwritten | Spec -> Material -> Functional tiers, MIN_REFERENCES=2 |
| Recommended Rate (overwrite #4) | `src/ProjectCalibrationEngine.ts` | `runProjectCalibration` | 582-724 (write at 656-667) | all items, post-loop | `item.recommendedRate` overwritten | Unconditional except `engineeringAdjustment.applied`/`isOverridden`; can clobber a step-3 result |
| Recommended Rate (overwrite #5) | inline, `server.ts` | Task 8 self-validation | 4926-5023 (write at 4986-4990) | re-run of ProgressiveMatchingEngine | `item.recommendedRate` overwritten again | Triggers on its own independent "needs re-eval" rule set |
| Confidence (`confidenceScore`) | `src/RecommendationEngineV2.ts` / `EngineeringAdjustmentEngine.ts` / `ProgressiveMatchingEngine.ts` | multiple | see above | — | `item.confidenceScore` | Whichever stage wrote `recommendedRate` last also sets this |
| Confidence (6-facet profile) | `src/ProjectCalibrationEngine.ts` | `computeItemConfidenceProfile` | 388-479 | item, marketStats, rateSource | `item.{semantic,specification,pricing,engineering,historical,overall}Confidence` | **Documented in code as never affecting `item.status`** — a parallel, non-synchronized confidence surface |
| Approval Status | `server.ts` | inline, 3 sites | 4490, 4618, 4683 | `confidence >= 75` (twice, magic number repeated) / unconditional | `item.status` | Sequential overwrites, last stage wins |
| Validation Status (6 categories) | `server.ts` | `buildItemValidationResults` | 4778-4830 | item, marketStats | `item.validationResults{...pass,details}` | Independent thresholds (50, rate-band 0.5x-2x) — can disagree with `item.status` |
| Manual Pricing / Needs Review bucket | `src/components/RecommendationsTab.tsx` | `recommendationSummary` reducer | 462-473 | item.attentionFlags, item.status | UI bucket counts | Re-derives a 3-way bucket the backend never emits as one field |
| Drawer "review required" badge | `src/components/RecommendationsTab.tsx` | `showReviewRequired` | 1419-1420 | `manualReviewRequired` (dead field) OR validationResults | boolean | Does not consult `item.status` at all |
| Table-row badge | `src/components/RecommendationsTab.tsx` | `hasAuditFail` + status | 1099, 1294, 1299 | validationResults + item.status | boolean | Different logic from the drawer badge above, on the same item |
| Confidence color threshold | `src/components/RecommendationsTab.tsx` | inline | 1272 | `item.confidenceScore >= 80` | emerald/amber | Third magic threshold, distinct from backend's 75 |
| Auditor re-label | `server.ts` | inline | 5063-5108 | item.status | `auditRecords[].status` (`VERIFIED`/`NEW_ITEM`), `replayAuditorReport.replayAccuracy` | Pure consumer of status, but a 3rd vocabulary for the same fact |
| Export gate (rate pairing) | `server.ts` | inline | 5840 | items | 422 block | Independent structural check |
| Export gate (replay accuracy) | `server.ts` | inline, x2 (Debug + Production) | 6008-6141 / 6142-6260 | exported vs expected cell rate | 422 block | Own "accuracy" formula, gated on `rfq.replayDetected` which is **never set anywhere** — dead code |
| Export filter (live) | `server.ts` | inline | 5819 | item.status | which rows get written | Pure consumer |
| System-health "replayAccuracy" | `server.ts` | inline | 6671-6673 | item.status, global | number | 4th distinct "accuracy" formula (see §4.6) |
| System-health "recommendationAccuracy" | `server.ts` | inline | 6677 | item.status | number, fallback 89.5 | 5th distinct formula |
| Analytics "accuracyBase" | `server.ts` | inline | 6332-6348 | item.status, overrides | number, fallback 85; feeds a trend history where **3 of 5 points are hardcoded literals** | 6th distinct formula |
| System-health "regressionSummary" | `server.ts` | inline | 6648-6658 | none | **hardcoded** `passed: true`, fabricated durations | Fake PASS report entirely disconnected from the real `/api/admin/regression-test` endpoint (L6704+) |

---

## 3. The Dormant Parallel Engine (`backend/src/engines/*`)

Verified facts (see full sub-agent investigation for citations):

- **No store contamination.** `KnowledgeBaseEngine.ts` reads/writes only `backend/data/knowledge-base-store.json`; every other V2 engine is pure/in-memory; `RecommendationLogger.ts` writes its own append-only log. None touch `master_boq_store.json`, `historical_boqs_store.json`, `rfqs_store.json`, `rfq_items_store.json`, or `replay_database.json`.
- **No live call path.** `/api/rfqs/:id/recommend-v2` (server.ts:5163) is never invoked by any file under `src/`. The `EngineeringParser.parse()` hooks inside `setImmediate()` on the historical-BOQ and RFQ upload routes are genuinely log-only and side-effect-free.
- **But it is a real, competing reimplementation**, not a stub: `backend/src/engines/RecommendationEngineV2.ts` uses an explicit 6-rule decision-rule switch (`EXACT_MATCH`/`SPECIFICATION_MATCH`/.../`NO_MATCH`) with its own `RecommendationStatus = "RECOMMENDED" | "ENGINEERING_REVIEW_REQUIRED"`, and `backend/src/engines/ConfidenceEngine.ts` implements a 5-factor confidence model with discrete bands (`VERY_HIGH`...`VERY_LOW`) — structurally unrelated to the legacy 6-facet weighted-blend model in `ProjectCalibrationEngine.ts`. Both classes share the literal name `RecommendationEngineV2`, disambiguated only by an import alias (`server.ts:51`, `RecommendationEngineV2New`).
- **Risk framing:** this is dead code today, but it is a landmine for future development — "improve the confidence engine" is now an ambiguous instruction with a 50/50 chance of editing the wrong, unreachable copy.

---

## 4. Complete Data Flow Trace — one item, "150 mm AAC Block Wall"

| Step | Location | What happens to the item |
|---|---|---|
| 1. Upload | `server.ts` `POST /api/rfqs` (~3688-3951) | Row parsed into `RFQItem{originalDescription:"150 mm AAC Block Wall", unit, quantity, recommendedRate:0, confidenceScore:0, status:"Pending", reason:"Pending analysis"}` |
| 2. Parser | `BOQParserEngine.parseWorksheet`/`parseWorkbookForUpload` | Header/column detected, row extracted, hierarchy tagged. No pricing. |
| 3. Master BOQ lookup | `server.ts` reads `descriptionToMasterIdIndex`/`masterItemIdIndex` (built at startup, §1) | If "150mm AAC Block Wall" (or a fuzzy variant) exists in the Master catalog, `matchedMasterId` is resolvable |
| 4. Project Retrieval | `RecommendationEngineV2.getSimilarProjects` (once per run, not per item) | Produces the Top-5 project shortlist that bounds all later evidence for this item |
| 5. Item Matching | `HistoricalRetrievalEngine.retrieveRankedHistoricalCandidates` | Returns ranked `historicalCandidates` for "AAC Block Wall" bounded to the Top-5 projects, each with `overallMatchScore` |
| 6. Spec Matching | `isCommerciallyEquivalent("150mm AAC Block Wall", candidateDescription)` | E.g. a "200mm AAC Block Wall" candidate is rejected/downweighted as non-equivalent (thickness qualifier differs) unless engineering adjustment handles the dimension explicitly |
| 7. Engineering Understanding | `EngineeringAdjustmentEngine.computeEngineeringAdjustment` | If no exact 150mm match exists but 100mm/200mm AAC walls do, builds a family and **linearly interpolates** a 150mm rate; sets `item.engineeringAdjustment`, **overwrites `recommendedRate`/`confidenceScore`/`status`/`reason`** |
| 8. Historical Evidence | `ProjectCalibrationEngine.selectHistoricalEvidence` | Filters candidates (stale/incorrect/premium-mismatch), picks the single best-matching rate as `selectedRate`, blends a bounded learning nudge into `representativeRate` |
| 9. Commercial Decision (baseline) | `RecommendationEngineV2.recommendItem` (server.ts:4487-4493) | **This actually runs BEFORE step 7-8 in wall-clock order inside the per-item loop** — sets the first `recommendedRate`/`confidenceScore`/`status`/`matchedMasterId`/`recommendationTrace` |
| 10. Commercial Decision (overwrite) | Engineering Adjustment branch, `server.ts:4616` | If step 7 applied, overwrites step 9's rate |
| 11. Commercial Decision (overwrite) | `ProgressiveMatchingEngine`, `server.ts:4666-4688` | Only fires if engineering adjustment did NOT apply and candidates < 2; would not normally fire for a common item like AAC block wall which usually has ≥2 candidates |
| 12. Commercial Decision (overwrite, whole-database pass) | `ProjectCalibrationEngine.runProjectCalibration`, `server.ts:4839-4848` | Runs **after every item in the RFQ has already gone through 9-11**. Recomputes `selectHistoricalEvidence` fresh and **overwrites `recommendedRate` again** if the deviation from step 9's value is ≥0.5%, unless step 7 applied or the item was manually overridden |
| 13. Validation | `buildItemValidationResults`, `server.ts:4778-4830` (called twice: main loop L4916, self-validation L5008) | Independently re-derives 6 pass/fail flags from `confidenceScore`/`marketRateStatistics`/rate-band — **can disagree with `item.status`** set in steps 9-12 |
| 14. Confidence profile | `computeItemConfidenceProfile`, called from `runProjectCalibration` L614 | Writes 6 confidence sub-scores that are architecturally separate from `confidenceScore` and never reconcile with `item.status` |
| 15. Self-validation pass | `server.ts:4926-5023` | Own independent "needs re-eval" rule (referenceCount<2, pricingConfidence<50, rate outside 0.5x-2x band **recomputed a third time**, extrapolation, >25% deviation from representativeRate); may overwrite `recommendedRate`/status/confidence one final time |
| 16. Dashboard | `RecommendationsTab.tsx` `recommendationSummary` L462-473 | Independently re-buckets the item into Auto Approved/Needs Review/Manual Pricing — **any** attention flag (even a benign "UOM Conversion" note) routes an `Accepted` item into "Needs Review" here, contradicting the backend's own status |
| 17. Drawer vs table row | `RecommendationsTab.tsx` L1294/1299 vs L1419-1420 | Two independently-coded badges on the same item can show different verdicts simultaneously (documented contradiction, §5.2) |
| 18. Auditor | `server.ts` L5063-5108 | Re-labels the same status as `VERIFIED`/`NEW_ITEM`, computes `replayAccuracy` from it |
| 19. Export | `server.ts` L5819 (live filter, consumer) + L6008-6260 (dead-code replay gate) | Item is written to the output workbook if `status` is `Accepted` or `Needs Manual Review` |

**Net effect:** the item's final commercial rate is the product of up to 5 sequential, independently-triggered overwrites with no single object anyone can point to as "the" decision until the very last write — and even after that, at least 3 separate downstream layers (validation, dashboard bucketing, auditor) recompute their own opinion about whether that rate/status should be trusted, using thresholds that are not shared constants and can disagree with each other and with `item.status` itself.

---

## 5. Documented Conflicts (Contradictory Outputs)

1. **Approval status vs. Validation status.** An item can have `status: "Accepted"` (confidence 76 ≥ 75) while `validationResults.commercialValidation.pass === false` (rate falls outside the historical 0.5x-2x band) — `server.ts:4917-4918` only logs an attention flag when this happens; it never reconciles `status`.
2. **Table row vs. detail drawer, same item.** Table row badge (`RecommendationsTab.tsx:1294`) uses `hasAuditFail || item.status === "Needs Manual Review"`. Drawer badge (`:1419-1420`) uses `manualReviewRequired || validationResults.some(pass===false)` and **never reads `item.status`**. Since `manualReviewRequired` is a dead field never written by the backend, the drawer's verdict can differ from the table row's for the same item — reproducible, not hypothetical.
3. **Dashboard bucket vs. backend status.** `recommendationSummary` (`RecommendationsTab.tsx:462-473`) sends any item with `(attentionFlags.length > 0)` to "Needs Review" even when `status === "Accepted"` — a benign informational flag (e.g., "AI Estimated", "UOM Conversion") demotes an approved item on the dashboard only.
4. **Color threshold vs. status threshold.** Frontend confidence-badge color cutoff is 80 (`RecommendationsTab.tsx:1272`); backend approval cutoff is 75 (`server.ts:4490`/`4618`). An item at confidence 77 is "Accepted" by the backend but rendered amber ("needs attention" color), not green.
5. **Four/five different "accuracy" formulas**, scoped differently (per-RFQ vs. global vs. analytics trend) and one (`regressionSummary`) entirely hardcoded to `passed: true` regardless of actual system state — §2 table, §4.6.
6. **Two `RecommendationEngineV2` classes** with the same name and different business rules for rate/confidence/approval, disambiguated only by an import alias. Not a live output conflict today (dead code), but a "which one is authoritative" landmine for the next engineer who touches "the" recommendation engine.
7. **Dead-but-armed export gate.** The Historical Replay Auditor export block (`server.ts:6008-6260`) still contains a full, real 422-blocking implementation gated on `rfq.replayDetected`, a field nothing sets. If any future change re-introduces replay detection without also revisiting this block, export could start failing under a code path nobody currently exercises or tests.

---

## 6. Duplicate Business Logic — Ranked by Risk

1. **`buildItemValidationResults` vs. the `item.status` threshold logic** (server.ts) — two independently-thresholded pass/fail conclusions on the same item, explicitly documented in code comments as intentionally separate, but the disagreement is real and reaches the UI.
2. **Drawer badge vs. table-row badge** (`RecommendationsTab.tsx`) — provably contradictory for the same item.
3. **`recommendationSummary` dashboard bucketing** (`RecommendationsTab.tsx`) — a second, client-side approval decision the backend never emits as one field.
4. **The dormant `backend/src/engines/*` tree** — a complete second implementation of rate/confidence/approval business rules, unreachable today but colliding in name and concept with the live engines.
5. **Five sequential overwrite sites for `item.recommendedRate`** (server.ts + 3 engines) — not simultaneous duplicates, but a "last write wins" chain with no shared representation of "why did the rate end at this value" until `recommendationTrace`/`calibrationReason`/etc. are stitched together after the fact.
6. **Magic-number thresholds repeated verbatim** instead of shared constants: confidence-approval cutoff `75` (server.ts, 2 sites), validation-pass cutoff `50` (server.ts), rate-plausibility band `0.5x-2x` (computed independently 3 times: `buildItemValidationResults`, self-validation pass, and originally in `HistoricalRetrievalEngine`'s plausibility filter), frontend color cutoff `80`.
7. **Four-to-six differently-scoped "accuracy"/"regression" metrics** across `server.ts` endpoints, one of which (`regressionSummary`) is fully fabricated.

---

## 7. What Is Genuinely Fine (Not a Duplicate)

To avoid over-flagging: the five `recommendedRate` writers are *sequential*, not *simultaneous* — each stage is explicitly gated (`if (adjustment.applied)`, `if (!engineeringAdjustment?.applied && !isOverridden)`, etc.) so only one of them fires per item per pass, by design. The problem is not that multiple things compute a rate — every stage after Master BOQ lookup legitimately refines the rate — the problem is that there is no single object capturing "the decision," so every downstream consumer (validation, dashboard, auditor, export) has had to independently reconstruct an opinion about what the final decision *means*, and those reconstructions have drifted from each other and from the true final state of `item.status`/`item.recommendedRate`.

This distinction is the basis for the refactor plan in the companion ADR: **do not collapse the five pricing stages into one function** (they represent real, distinct engineering steps — baseline, engineering adjustment, progressive relaxation, market calibration, self-validation — and collapsing them would violate the "never rewrite working matching/adjustment modules" constraint from prior sessions). **Do** collapse the *interpretation* of the final state (approval/validation/bucketing/badges/auditor labels/export gates) into one shared decision object computed once, at the end of the pricing chain, and consumed everywhere else read-only.

See `docs/adr/0001-single-source-of-truth-commercial-decision.md` for the refactor plan and Architecture Decision Record.
