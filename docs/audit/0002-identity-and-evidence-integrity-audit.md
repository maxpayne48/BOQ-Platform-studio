# Audit 0002 — Project-Identity Similarity & Evidence-Integrity Findings

Date: 2026-07-24
Scope: the five specific problems in the brief (identical-BOQ replay, 41%/50%/50% similarity, ₹310→₹1050-shaped rate substitution), re-checked against the **current** code (post ADR-0001) and against the project's own persisted stores.
Method: static trace + live data forensics. `rfqs_store.json`, `rfq_items_store.json`, `historical_boqs_store.json` already contain a real, self-referential reproduction of Problem 1 — used as ground truth instead of speculation.

**Relationship to existing docs:** `docs/audit/recommendation-pipeline-audit.md` + `docs/adr/0001-single-source-of-truth-commercial-decision.md` were already implemented today and correctly fixed a *different* failure class (5 independent re-derivations of approval/status). That work is real and holds up under inspection. **It did not touch, and could not have fixed, the defects below** — they live one layer upstream, in Stage-1 project-similarity input and in the historical-evidence selection fallback, not in the approval/interpretation layer ADR-0001 addressed.

---

## 0. The reproduction already sitting in the data

`rfqs_store.json` contains `rfq_pl2g9aiph`, `projectName: "Copy of KOHLER PUNE FS 16TH JUNE"` — a literal re-upload of historical project `hist_vsro0d05m`, `"KOHLER PUNE FS 16TH JUNE"`. This is Problem 1's exact test case, already run, already rated. Observed:

- A quarter-plus of items had recommended rates deviating **more than 5%** from the historical rate attached to their own byte-identical description match.
- Some deviations were catastrophic: `"Tile Cladding (1200mm X 1200mm) - Type 2"` — historical ₹3,500 → recommended **₹0.15**. `"Water Body flooring"` — historical ₹550,000 → recommended **₹0.15**. `"PCC - upto 75-100mm thick"` — historical ₹1,050 → recommended ₹5,500.

This is the ₹310→₹1050 pattern from the brief, reproduced at scale, with exact file/function root causes (§3).

---

## 1. Why Project Similarity reads 41% for an identical project

`src/RecommendationEngineV2.ts` (`getSimilarProjects`) is architecturally sound — a genuine weighted multi-factor score (type 30%, cost 20%, size 20%, city 20%, grade 10%); for a truly identical project every factor should hit 1.0. The bug isn't the scoring function — it's what gets fed into it.

`server.ts`, inside `POST /api/rfqs/:id/recommend`: whenever the recommend request doesn't carry explicit `projectCost`/`projectSize`/`city` and the RFQ's own `projectContext` hasn't been populated with real values, these fall back to **fixed placeholder constants**: ₹1.5 Cr, 50,000 sq ft, "Delhi NCR", "Commercial Office" — regardless of what the uploaded file actually is.

For `rfq_pl2g9aiph` (real Kohler profile: real replay-derived cost, 6,91,250 sq ft, Pune): Type match (0.30) + Grade match (0.10) + ~0 on cost/size/city = **~0.40 → the 41% in the brief**. Persisted in `rfq_items_store.json` as `projectSimilarity: 41` on multiple items.

**Root cause:** the system has no way to notice "this RFQ's own historical twin is sitting right there in the historical database" and silently substitutes a generic profile that looks nothing like the real one.

---

## 2. Why Item/Specification Similarity read ~50% for identical descriptions

They don't, at the layer that computes them. `HistoricalRetrievalEngine`'s `wordOverlapScore` correctly returns **100** for identical text (confirmed in persisted data: `scores: { semantic: 100, specification: 100, material: 100 }`). The "50%" is the downstream composite: `overallMatchScore` is a **product** (by explicit design), so `projectFrac = 0.41` from §1 multiplies a perfect 100/100/100 item match down to ~51. Fixing §1 fixes this symptom automatically — no change needed to the scoring functions.

---

## 3. Why a correct historical rate gets rejected in favor of a wrong one (the ₹310→₹1050 mechanism)

Observed live on `rfqit_li3zpt01i` ("Tile Cladding (1200mm X 1200mm) - Type 2"): `historicalCandidates` contained exactly one properly-gated candidate (Kohler, ₹3,500) — but the final evidence pool contained candidates from ungated paths, including a corrupted **₹0.15** rate, which was `selected: true`; final `recommendedRate: 0.15` with `decision.failedValidations: []`.

**Root cause A — data quality:** `"Vitrified tile - Type - 01 - 800mm x 800mm"` recorded at ₹0.165 in the master catalog — physically impossible, 4-5 orders of magnitude off neighboring rates. No rate-plausibility check existed at ingestion.

**Root cause B — ungated fallback:** `ProjectCalibrationEngine.selectHistoricalEvidence`'s else-branch falls back to `matchedMaster.historicalRates` raw — bounded only by the Stage-1 shortlist, never by the Item-Family/UOM/commercial-equivalence/plausibility gates the primary path enforces. Similarly, `ProgressiveMatchingEngine.buildCandidatesFromMasters` pooled raw rates from every project in the catalog with identical flat synthetic scores — so "selection" degenerated to array order.

**Root cause C — self-anchored guard:** `HistoricalRetrievalEngine`'s ±3x plausibility band anchors to `ranked[0].rate` — the top-scored candidate — so a noise-ranked corrupted candidate can protect itself and reject the correct evidence.

**Root cause D — quantity over quality:** the self-validation pass adopted a re-estimate whenever it had *more references* ("16 reference(s) vs. 1 previously"), letting loosely-related relaxed-tier pools displace a single exact historical match.

**Why validation didn't catch it:** the commercial-plausibility check compares the recommended rate against the selected evidence's own min/max — the corrupted number is validated against itself.

---

## 4. Direct answers to the brief's numbered questions

1. **Same BOQ ≠ same recommendations?** Stage-1 inputs silently defaulted (§1) + ungated evidence fallback (§3). Both deterministic, both cited to file/line.
2. **Project Similarity 41%?** §1 — fabricated default profile vs the real historical profile.
3. **Item Similarity 50%?** §2 — multiplicative composite propagating §1's broken project score; item scoring itself returns 100.
4. **Specification Similarity 50%?** Same as #3.
5. **Correct rate rejected?** §3 Root Causes A-D.
6. **Wrong rate selected?** Won the ranking inside an ungated pool (or was protected by the self-anchored guard).
7. **Where is the recommendation generated?** Unchanged from the prior audit: baseline → engineering adjustment → progressive matching → calibration → self-validation, per `server.ts`.
8. **Which code computes similarity?** Project: `RecommendationEngineV2.getSimilarProjects`. Item/spec: `HistoricalRetrievalEngine`'s `wordOverlapScore`/`numericJaccard`. Composite: `HistoricalRetrievalEngine` overallMatchScore product.
9. **Which code ranks evidence?** `HistoricalRetrievalEngine` (candidate list) and `ProjectCalibrationEngine.selectHistoricalEvidence` (selection) — §3 shows the second sometimes ran over a different, ungated pool.
10. **Does Master BOQ influence commercial recommendation?** Only as the vehicle for historical rates + engineering classification — the defect is an un-vetted corrupted value, not architectural leakage.
11. **Does fallback logic override historical evidence?** Yes — §3 Root Cause B, concretely.
12. **Duplicated engines?** No longer — ADR-0001 removed them; confirmed.
13. **Architectural violations/dead code?** `recommendationTrace.explanation` written once by the baseline stage and never regenerated on later overwrites — a trace can tell a fabricated provenance story (e.g. "₹3,500 used directly" for a ₹0.15 item). A narrower recurrence of the "5 writers" problem, unfixed by ADR-0001 (which covered approval status only).
14. **Can identical projects fail to produce identical outputs?** Yes — confirmed in this codebase's own persisted data.

---

## 5. Fixes, in severity order

1. **(Highest — silent price corruption)** Stop `selectHistoricalEvidence`'s fallback (and every other evidence pool) from bypassing gating.
2. **(High — data quality)** Rate-plausibility check at Master BOQ ingestion (median/MAD, not min/max); flag/quarantine with a trace, never silently drop.
3. **(High — root cause of 41%/50%/50%)** Recognize a re-uploaded historical project and use its real profile instead of placeholder defaults. Input-completeness fix only — no rate bypass.
4. **(Medium)** Anchor the retrieval plausibility guard to something more robust than `ranked[0]`.
5. **(Medium)** Regenerate `recommendationTrace` whenever a later stage overwrites the rate — single writer at the end, same pattern as approval status.
6. **(Low, hygiene)** Validate the selected rate against a source-independent sanity band as a second line of defense.

---

## Implementation Notes (2026-07-24, same day)

Fixes **1, 2, 3, and 5** were implemented as four separate commits (fix 4 — the `ranked[0]` anchor — and fix 6 were explicitly out of the requested scope and remain open; fix 4's failure mode is however substantially defused because the pool-median gate below never anchors to the top-ranked candidate).

**Regression metric.** `test_historical_replay.cjs` was rewritten first (commit `2477f34`) — the old script depended on retired fields (`matchedProjectName`, `replayDetected`, `item.status`). It joins the RFQ's items to the historical project's row mappings by sheet+row (fallback: unambiguous exact description) and counts recommended-vs-historical deviations > 5%. All numbers below are on `rfq_pl2g9aiph` ("Copy of KOHLER PUNE FS 16TH JUNE"), 539 ground-truth-matched items, recommend invoked **with an empty request body** (the exact defaulted-profile path that produced the original failure):

| State | >5% deviations | Catastrophic (>90% off) | Kohler project similarity |
|---|---|---|---|
| Baseline (post-ADR-0001, pre-fix) | **280 (51.9%)** | 94 | 41% |
| After fix 1 (evidence gating) | 239 (44.3%) | 42 | 41% |
| After fix 2 (ingestion quarantine) | 239 (44.3%) | 42 | 41% |
| After fix 3 (real twin profile) | **118 (21.9%)** | 31 | **95% (rank #1)** |
| After fix 5/trace fix | 118 (21.9%) | 31 | 95% |

**Fix 1 (commit `4d32c03`) — every evidence pool gated.** (a) `ProjectCalibrationEngine.filterHistoricalEvidence` gained an "Implausible Rate" rejection: order-of-magnitude outliers (5x ratio band) against the **median of the candidate pool itself** (≥3 observations) — applied uniformly to primary candidates, the matched-master fallback branch, and relaxed-tier pools, and anchored to the pool median so a corrupted value can never protect itself by out-ranking the guard. The fallback branch's item-family/UOM/equivalence gates are inherently satisfied there (the pool is the same matched master's own sibling rates) — documented in place. (b) `ProgressiveMatchingEngine.buildCandidatesFromMasters` now hard-excludes projects outside the Stage-1 shortlist and scales the synthetic tier score by the originating project's Stage-1 similarity — previously all tier candidates carried an identical flat score, so selection degenerated to array order (how ₹0.15 beat ₹2,646-₹4,000). (c) Root Cause D: the self-validation adoption rule compares evidence **quality** (`selectedMatchScore`) instead of pool size; reference count is only the tiebreak. Wrong-item substitutions (fire extinguisher ₹480 → ₹36,000 class) were eliminated by this commit.

**Fix 2 (commit `c84f99b`) — ingestion quarantine.** `precomputeMasterItemFields` vets `historicalRates` before any stats are derived: a rate 10x off the median of its own siblings AND ≥6 MAD-based robust z-scores outside the item's own dispersion is moved to a new auditable `MasterBOQItem.quarantinedRates` field (reason + project, console-logged) and removed from all parallel occurrence arrays. A one-time vetting migration triggers off the marker's absence. On the current store it quarantined exactly 4 rates (e.g. ₹96,070 "40mm dia." vs sibling median ₹3,046). The MAD guard deliberately protects legitimately wide spreads — e.g. ambiguous "150 NB" masters pooling a real ₹90 Kohler rate with ₹3-5k cross-project scopes are NOT quarantined. **Residual data debt:** masters whose *every* sibling is corrupted (`"Vitrified tile - Type - 01"` at [0.15, 0.18]) are undetectable by intra-item comparison; they stay guarded only by fix 1's pool gate, and would need a domain-level sanity band (audit fix 6) to be caught at source.

**Fix 3 (commit `afc6309`) — real profile for a recognized re-upload.** The recommend route normalizes the RFQ's projectName/fileName (strips "copy of", extensions, punctuation) and matches it against `historicalBOQs`. On a match, the historical record's real profile (actual cost via `getHistoricalProjectCost`, real size/city/type) fills any parameter the request didn't provide. Precedence: explicit request body > identified twin > RFQ's own `projectContext` (deliberately below the twin — projectContext is overwritten with whatever profile a previous run used, so after one defaulted run it holds exactly the fabricated values) > placeholder default. No rate bypass, no exact-match branch — Stage-1 and all downstream stages run unchanged on better inputs. Kohler similarity went 41% → 95% and the deviation count halved.

**Fix 5 (commit `0b020a1`) — trace reconciliation.** `CommercialDecisionEngine.finalizeItemDecision` now reconciles `recommendationTrace` exactly once, at the end (same single-writer pattern as approval): `trace.recommendedUnitRate` is set to the true final rate and `trace.explanation` is rebuilt from the winning stage's own recorded reasoning, prefixed with the shared `deriveRateProvenance` label; the baseline's original explanation is preserved verbatim in a new `trace.baselineExplanation` field (set once, idempotent). Result: 672/672 items have `trace.recommendedUnitRate` identical to the final rate (previously divergent for every later-stage overwrite); 314 traces were reconciled to a later stage on the Kohler run.

**Residual deviation profile (the remaining 118).** Dominated by ambiguous child-row descriptions that legitimately price differently per parent context but share one master item — e.g. "End terminations" appears in Kohler itself at ₹120-₹2,200 depending on the parent cable spec, and every such row now receives the same (Kohler-sourced, plausible, but context-blind) rate. Fixing this class requires parent-hierarchy-aware item identity (using `item.parentHierarchy` in master matching/retrieval), which is a feature beyond this audit's scope; the "Ambiguous Sub-Item Description" attention flag already marks these rows for review. Of the four explicitly-named catastrophic examples from §0: Water Body flooring (₹550,000), Glass Flooring (₹45,000) and PCC (₹1,050) now reproduce their historical rates exactly; Tile Cladding Type 2 recommends ₹3,000 vs historical ₹3,500 (14.3% off — a near-variant Kohler tile-cladding rate was selected over the exact Type-2 match; correctly surfaced as Needs Review rather than silently Auto Approved, and no longer the ₹0.15 catastrophe).

**Explicitly not modified** (per the brief, verified correct against live data): `wordOverlapScore`, `numericJaccard`, the multiplicative `overallMatchScore` formula, and `getSimilarProjects`' weighting logic.

---

## Follow-up Fix (2026-07-24, later same day) — bug report on "Tile - Type -01 (1200mm x 1200mm)"

**Trigger.** A drawer bug report on this exact item (Row 7, Interior, `rfq_pl2g9aiph`): header "Recommended Unit Rate" showed ₹1,600, "Selected Historical Rate" and the Historical Evidence table both showed ₹3,000 (Kohler, 100%/100% item/spec similarity, marked SELECTED), and the Pricing Explanation text itself claimed "Self-validation second pass replaced a weakly-supported estimate (₹1600.00) with a better-evidenced one (₹3000.00)" - a self-contradicting drawer. The report posed two hypotheses: (a) `recommendedRate` itself is wrong (self-validation decided but failed to persist), or (b) only `recommendationTrace.recommendedUnitRate` is stale (fix 4's reconciliation missed a subfield).

**Diagnosis method.** Static reading of the persisted record alone could not distinguish the two hypotheses cleanly, so the pipeline was instrumented with per-stage `console.log`s for this item (baseline, post-`HistoricalRetrievalEngine`, post-`ProjectCalibrationEngine.runProjectCalibration`, self-validation entry/relaxed-candidate/adoption-decision, pre/post `CommercialDecisionEngine.finalizeItemDecision`) and `/recommend` was re-run live. The trace showed:

```
[baseline]         recommendedRate=3000  matchedMasterId=mstr_f8g3450s7  confidence=85  source=Basic Rate
[post-calibration]  recommendedRate=1600  calibrationApplied=true  calibrationReason="...1600...3000..." (STALE - pre-existing on the item before this run even started)
[self-validation]   reasons=["Weak historical support (<2 references)", "...46.7% deviation..."]
[self-val relaxed]  relaxedMatchScore=67 < currentMatchScore=100 -> better=false (correctly declined to act)
[pre-decision]       recommendedRate=1600  (unchanged by self-validation this run)
```

**Actual root cause - neither hypothesis (a) nor (b) as framed, but severity-equivalent to (a).** `recommendedRate` really is wrong (1600 instead of the correct 3000), but the mechanism is a third, more fundamental defect:

1. **Engineering Adjustment overrides an already-exact historical match.** `result.source` from `RecommendationEngineV2.recommendItem` is *unconditionally* `"Basic Rate"` for every item (confirmed in source: no separate exact-match branch exists), so `server.ts`'s gate `if (result.source === "Basic Rate")` before invoking `EngineeringAdjustmentEngine.computeEngineeringAdjustment` ran for every item regardless of match quality - including this one, which already had `matchedMasterId` set via an *exact* (lowercased, trimmed) description match against the Master Catalog, confidence 85, baseline rate ₹3,000 "used directly" per `RecommendationEngineV2`'s own generated text. Engineering Adjustment then built a dimensional "family" keyed on `"tile type size"` that pooled in **a Lintel** (`"Type 02 - Size of Lintel: 150mm x 150mm"`, ₹850 - an unrelated item, not a tile at all), **the known ₹0.165 corrupted vitrified-tile rate** (documented as residual data debt in this audit's Fix 2 notes - undetectable by intra-item quarantine since every sibling of that master is corrupted), and **an unrelated "Printed Tile Flooring" variant** (₹1,600, coincidentally also 1200mm) - and used that contaminated 4-item family to Area-Scale/interpolate ₹1,600, overriding the genuine ₹3,000 exact match. Self-validation's own trigger conditions ("weak support", "high deviation") were then just detecting the *symptom* of this corruption (comparing the corrupted 1600 against the correct 3000 evidence), not a separate issue.
2. **`item.calibrationApplied`/`item.calibrationReason` are never reset at the start of a run.** These two fields were left over from a *prior* run (before this session's earlier Fix 1 changed the self-validation adoption criteria) where self-validation *had* adopted a switch to ₹3,000. On the current run, self-validation correctly declined to act (`better=false` - the exact match's evidence quality, 100, beats the relaxed alternative's 67), but nothing ever clears `calibrationApplied`/`calibrationReason` when self-validation's "not adopted" branch runs, so the stale ₹1,600→₹3,000 narrative kept displaying indefinitely, describing a decision that no longer held.

**Fixes applied (server.ts, src/CommercialDecisionEngine.ts):**
1. Gated Engineering Adjustment to `result.source === "Basic Rate" && !result.matchedMasterId` - it is a fallback for the true "flat catalog guess" case (no master match at all), never a second opinion on an already-exact match, matching the block's own pre-existing comment ("the flat Basic Rate catalog guess is replaced") which the code never actually enforced.
2. `item.calibrationApplied = false; item.calibrationReason = undefined;` explicitly reset at the top of each item's per-run processing (same "explicitly clear rather than merely skip" convention already used for `installationRate` in the same loop), so these fields can never carry a narrative across runs unless a stage in *this* run actually sets them.
3. Extended `CommercialDecisionEngine.reconcileRecommendationTrace` (the Fix-4 mechanism) to also sync `trace.historicalUnitRate` to `item.marketRateStatistics.selectedRate` whenever they diverge - the same staleness class the bug report's hypothesis (b) predicted, just in a field fix 4 didn't originally cover.

**Step 3 regression check - confirms the bug report's suspicion that fix 4's original check had a gap.** Fix 4 only ever verified `recommendedRate === recommendationTrace.recommendedUnitRate`, which are written together by the same code and so trivially agree even when both are wrong (they did, at 1600, on the buggy record). Re-running the expanded check against every rate-bearing field the drawer reads:

| Check | Before (committed baseline, 672 rated items) | After fix |
|---|---|---|
| `recommendedRate` vs `decision.recommendedRate` | 0 | 0 |
| `recommendedRate` vs `recommendationTrace.recommendedUnitRate` (fix 4's original, only, check) | 0 - **passed clean on the buggy data, confirming the gap** | 0 |
| `recommendationTrace.historicalUnitRate` vs `marketRateStatistics.selectedRate` | 292 | 0 |
| `calibrationReason`'s claimed final value vs actual `recommendedRate` (the real defect signature) | **113** | 0 |

**Step 4 - scan for other instances, confirmed widespread, not a one-off.** Scanning the pre-fix committed store (`rfq_pl2g9aiph`, 672 rated items) for Engineering Adjustment applied despite a 100%/100%-similarity exact historical match already present in `marketRateStatistics.historicalEvidence`: **88 items (13%)** - e.g. "Boardroom Table (5600mm x 1800mm)", four separate glazed-door types, "Waterproofing (For Floor + Walls 600mm High)". This was a systemic pipeline defect, not specific to the reported tile item.

**Overall regression impact.** `test_historical_replay.cjs` on `rfq_pl2g9aiph`: >5% deviations **118 → 72 (21.9% → 13.4%)**, catastrophic (>90%) 31 → 29. This is the largest single-fix improvement since Fix 3 (the project-identity fix) - confirming Engineering Adjustment overriding exact matches was a materially significant, previously-undetected pricing defect, not merely a display inconsistency.

**Lesson.** A regression check that only compares two fields written by the *same* code path (`recommendedRate` and `recommendationTrace.recommendedUnitRate`, both set by the same self-validation write) can pass cleanly while both are simultaneously wrong relative to the actual evidence. The check that would have caught this - cross-referencing `calibrationReason`'s own claimed outcome against the field it claims to describe - didn't exist until this fix. When verifying "does X match Y," prefer checking X and Y against an independent third source (here, the evidence pool itself) over checking two fields that share a writer.
