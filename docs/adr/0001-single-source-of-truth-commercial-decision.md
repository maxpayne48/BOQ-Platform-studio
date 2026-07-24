# ADR-0001: Single Source of Truth for the Commercial Decision

- Status: Accepted (implementation pending)
- Date: 2026-07-24 (decisions on open questions confirmed by user same day)
- Audit this ADR is based on: `docs/audit/recommendation-pipeline-audit.md`

## Context

The recommendation workflow (RFQ upload → parsing → project retrieval → item matching → engineering adjustment → historical evidence → pricing → validation → confidence → dashboard → auditor → export) was built incrementally across many sessions, each extending the pipeline stage-by-stage without ever introducing a shared representation of "the decision" for an item. The audit found:

1. **Five sequential writers to `item.recommendedRate`** across `server.ts` and three engines, with no single object recording the final decision and why it was reached — only scattered fields (`recommendationTrace`, `calibrationReason`, `engineeringAdjustment.explanation`) that must be manually stitched together to answer "why is this the rate?"
2. **At least three independent re-derivations of approval/validation status** — `item.status` (backend, threshold 75, two call sites), `buildItemValidationResults` (backend, six-category pass/fail, thresholds 50 and a 0.5x-2x rate band), and client-side re-bucketing in `RecommendationsTab.tsx` (dashboard summary, table badge, drawer badge — three *different* client-side derivations of the same underlying question, not one).
3. **Magic-number thresholds duplicated** instead of centralized (75 twice in `server.ts`, 50 in validation, 80 in the frontend, the 0.5x-2x rate-plausibility band recomputed three separate times).
4. **A fully dormant, parallel reimplementation** of the same business rules (`backend/src/engines/*`, wired only to the never-called `/api/rfqs/:id/recommend-v2`) sharing a class name (`RecommendationEngineV2`) with the live engine, disambiguated only by an import alias.
5. **Reproducible, user-visible contradictions**: the same item can show "Accepted" in the main table and "Self-Validated Pass"-vs-"Manual Review" inconsistently in its own detail drawer; an approved item with a benign informational flag is silently demoted to "Needs Review" on the dashboard; four-to-six differently-scoped "accuracy" metrics disagree, one of which is hardcoded fake data (`regressionSummary`).

None of this is one bug. It is the accumulated cost of every consumer (dashboard, auditor, export, validation) independently re-deciding a business question instead of reading a decision that was already made once, upstream.

## Decision

We adopt one governing rule for all future development on this pipeline:

> **Every business decision is calculated exactly once, by exactly one designated authority. Every other module is a read-only consumer of that result.**

This does **not** mean collapsing the pricing pipeline into one function. The five pricing stages (baseline match, engineering adjustment, progressive relaxation, market calibration, self-validation re-evaluation) are genuine, sequential, distinct engineering steps and must remain separate — collapsing them would violate the standing project principle that working matching/adjustment logic is extended, not rewritten (see project memory `feedback_validation_not_target`, `engine_module_map`). What must be collapsed is the **interpretation layer**: the step that looks at wherever the pricing chain landed and decides approval/validation/bucket/badge/label. That interpretation currently happens in 6+ places; it must happen in exactly one.

### Design principles adopted

1. **A single `RecommendationResult` object per item**, assembled once, at the end of the pricing chain (after step 5, Task-8 self-validation), by a new **Commercial Decision Orchestrator**. It contains:
   - The final `recommendedRate` and full provenance (`trace`: which stage set it, why, what evidence).
   - The full confidence profile (6-facet, from `ProjectCalibrationEngine.computeItemConfidenceProfile` — kept as-is, it is not duplicated logic, just under-consumed).
   - **One** `approvalStatus: "AutoApproved" | "NeedsReview" | "ManualPricing"` derived from **one** rule, using named constants, not repeated literals.
   - **One** `validationSummary` (the six-category pass/fail), reconciled with `approvalStatus` rather than left free to disagree with it. **DECIDED: validation is a gate on approval** — an item is only `AutoApproved` if `overallConfidence >= CONFIDENCE_APPROVAL_THRESHOLD` **and** every `validationSummary` category passes. Failing either downgrades to `NeedsReview` (or `ManualPricing` for the zero-evidence case). This is intentionally stricter than today's live behavior, where `item.status` ignores `validationResults` entirely — some items currently shown "Accepted" will move to "Needs Review" once this ships. Confirmed as a deliberate product decision, to be re-validated against the historical-BOQ harness before considered safe.
   - A stable, versioned `reasonCode`/explanation string suitable for direct UI display ("Recommendation Summary" / "Pricing Explanation" in the original brief), so the UI never has to reconstruct prose from raw fields itself.
2. **Downstream modules become consumers, not deciders.** Dashboard bucket counts, table badges, drawer badges, the auditor, and export gates all read `item.approvalStatus`/`item.validationSummary` directly. None of them re-derive a threshold.
3. **Shared constants module** for every threshold currently duplicated: `CONFIDENCE_APPROVAL_THRESHOLD`, `VALIDATION_MIN_SUBSCORE`, `RATE_PLAUSIBILITY_BAND` (low/high multiplier). Defined once (proposed: `src/decisionConstants.ts`), imported by `server.ts`, the engines, and (via a generated/shared type or a thin API-exposed constants endpoint) the frontend, so a threshold is never "tuned in one place and silently stale in another."
4. **One vocabulary for status**, end to end: the `RFQItem.status` enum (`Pending`/`Accepted`/`Needs Manual Review`) is retired in favor of `approvalStatus` (Auto Approved / Needs Review / Manual Pricing — the exact three buckets the dashboard already displays, so the backend now emits what the UI was inventing). The auditor's `VERIFIED`/`NEW_ITEM` vocabulary and the dashboard's independent bucketing both collapse into reading this one field.
5. **Dead/dormant code is resolved, not left ambiguous.** `backend/src/engines/*`, the `/recommend-v2` route, and the upload-route hooks into it are deleted outright (confirmed safe — already committed to git history, zero live dependents per §3 of the audit).

### Which modules become authoritative for each decision

| Decision | Authoritative module (after refactor) | Everyone else |
|---|---|---|
| Recommended Rate + provenance | The existing 5-stage pricing chain (`RecommendationEngineV2` → `EngineeringAdjustmentEngine` → `ProgressiveMatchingEngine` → `ProjectCalibrationEngine` → self-validation pass), unchanged internally, but its final output is captured into `RecommendationResult.trace` by the new orchestrator instead of being left implicit | Read `item.recommendedRate`/`item.trace` only |
| Confidence (6-facet) | `ProjectCalibrationEngine.computeItemConfidenceProfile` (unchanged — already correctly centralized, just under-consumed) | Read `item.overallConfidence`/sub-facets only |
| Approval Status | New **Commercial Decision Orchestrator** (single function, e.g. `deriveApprovalDecision(item): {approvalStatus, reasonCode}`), called exactly once per item, after all pricing stages finish | Dashboard, table badge, drawer badge, auditor, export — all read `item.approvalStatus` |
| Validation Summary | Existing `buildItemValidationResults`, but its output is now an *input* to the orchestrator (feeds `approvalStatus`) rather than a parallel, unreconciled fact | Same consumers as above |
| Export eligibility | Export route reads `item.approvalStatus` (plus the independent, legitimate structural check `pairedRateViolations`, which is not a duplicate — it's a different concern, rate-pairing integrity, not approval) | N/A |
| System-wide accuracy/regression metrics | One shared helper, parameterized by scope (per-RFQ / global / analytics-trend), computed from `approvalStatus`, replacing the current 4-6 independent formulas | All dashboards/analytics/system-health endpoints call the shared helper with different scope arguments |

### How future developers add features without introducing duplicate logic

- If a new feature needs to know "is this item okay to ship," it reads `item.approvalStatus`. It never writes `if (confidence >= <number>)` anywhere outside the orchestrator file.
- If a new pricing signal is added (e.g., a future Phase 6), it becomes a new stage in the existing sequential chain, emits its result into the trace, and the orchestrator is the only place that has to be told the new signal exists for approval purposes.
- If a threshold needs tuning, it is changed in the shared constants module once; every consumer picks it up automatically.
- Any code that computes a "PASS/FAIL", "accuracy", or "confidence" concept a second time in a new file is, by definition, a regression against this ADR and should be caught in review.

## Refactor Plan

**Modules to remove:**
- `backend/src/engines/*` and the `/api/rfqs/:id/recommend-v2` route, `knowledgeBaseEngineV2`/`engineeringParser` fire-and-forget hooks in the upload routes, and the now-unreferenced imports at `server.ts:41-52` — **DECIDED: delete.** Confirmed safe: these files are already committed to git (initial commit), so removal is fully reversible via history. No frontend code, admin surface, or live store depends on them (§3 of the audit).
- The dead Historical Replay Auditor export gate (`server.ts:6008-6260`), gated on a field (`rfq.replayDetected`) nothing sets — either delete it or, if replay auditing is still wanted, re-wire it deliberately and add a test proving it fires.
- `manualReviewRequired` field (`src/types.ts`) — never written, only read once; delete the field and its one read site.

**Modules to merge:**
- `buildItemValidationResults` + the three scattered `item.status` assignment sites (`server.ts:4490`, `4618`, `4683`) + the Task-8 self-validation re-eval trigger logic → one Commercial Decision Orchestrator function/module.
- The four-to-six "accuracy"/"regression" formulas (`replayAuditorReport.replayAccuracy`, `/api/system-health` `replayAccuracy` and `recommendationAccuracy`, `/api/analytics` `accuracyBase`, the hardcoded `regressionSummary`) → one shared, parameterized accuracy helper. The fabricated `regressionSummary`/hardcoded trend points must either be wired to the real `/api/admin/regression-test` logic or explicitly removed — a "fake PASS badge" cannot survive this refactor under either merge or keep.

**Modules to simplify:**
- `RecommendationsTab.tsx`: delete `recommendationSummary`'s independent bucketing logic, `hasAuditFail`, and `showReviewRequired`'s bespoke boolean — replace all three with direct reads of `item.approvalStatus`.
- `server.ts`'s per-item loop: replace the three scattered `item.status = confidence >= 75 ? ... : ...` assignments with calls into the shared constants + orchestrator (the loop still runs the same pricing stages; only the interpretation step changes).

**Shared models/interfaces (new):**
- `RecommendationResult` (or extend `RFQItem` in place, to avoid an invasive rename): `{ recommendedRate, trace, confidenceProfile, validationSummary, approvalStatus, reasonCode }`.
- `src/decisionConstants.ts`: `CONFIDENCE_APPROVAL_THRESHOLD`, `VALIDATION_MIN_SUBSCORE`, `RATE_PLAUSIBILITY_BAND_LOW/HIGH`.
- `deriveApprovalDecision(item, validationSummary, confidenceProfile): {approvalStatus, reasonCode}` — the Decision Orchestrator, single source of truth for approval.

**Dependency graph after refactor:**

```
[5-stage pricing chain]  (unchanged internals)
        |
        v
[buildItemValidationResults]  ->  [deriveApprovalDecision]  ->  item.approvalStatus / item.reasonCode
        |                                  ^
        v                                  |
[computeItemConfidenceProfile] ------------+
        |
        v
   RFQItem (single, frozen-after-write decision fields)
        |
        +--> Dashboard (consumer only)
        +--> Table/Drawer badges (consumer only)
        +--> Auditor (consumer only)
        +--> Export gate (consumer only, plus independent pairedRateViolations structural check)
        +--> Accuracy/regression metrics (shared helper, parameterized by scope)
```

**Expected impact:**
- Eliminates conflict classes 1-3 and 5 from the audit (§5) entirely — there is only one place that can produce "Accepted" vs "Needs Review," so the table, drawer, and dashboard cannot disagree by construction.
- Makes the "why is this the rate/status" question answerable from one object instead of cross-referencing 5+ fields.
- Centralized thresholds mean a future tuning pass changes one constant instead of hunting for every repetition.

**Potential risks:**
- `item.status` is read in many places across `server.ts` (RFQ list views, exports, admin console) — renaming/replacing it to `approvalStatus` touches more call sites than the recommendation pipeline alone; needs a full grep-and-verify pass before cutover, not a blind rename.
- ~~The dormant `backend/src/engines/*` tree represents real design exploration — deleting it destroys that work.~~ **Resolved:** user confirmed deletion; the work remains recoverable via git history if ever needed.
- ~~`buildItemValidationResults`'s rate-plausibility band and the orchestrator's approval threshold disagree in practice — reconciling them is a product decision.~~ **Resolved:** user confirmed validation gates approval (stricter). Residual risk: this will move some currently-"Accepted" items into "Needs Review" — expect the Auto-Approved count to drop after cutover; this is intended, not a regression.
- Any change to `item.status`'s meaning risks regressing the ±5% deviation success metric this project is measured against (see project memory `project_vision_and_roadmap`) if approval bucketing logic shifts which items get auto-approved vs. reviewed. This refactor changes *where* the decision is made, not *what evidence* it's based on — but must be validated against the historical-BOQ test harness before being considered safe, per the standing "validation, not target" discipline already in force for this codebase.

## Consequences

- New code that needs an approval/validation/confidence answer has exactly one correct place to get it; adding logic anywhere else is a reviewable violation of this ADR.
- The five-stage pricing chain is preserved untouched in its internal engineering (no regression risk to matching/adjustment quality) — only the layer that interprets its output is consolidated.
- This document and `docs/audit/recommendation-pipeline-audit.md` should be updated together if a future change alters which module is authoritative for any decision listed here.
