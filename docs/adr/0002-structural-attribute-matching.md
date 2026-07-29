# ADR-0002: Structured Attribute Matching for Commercial Product Identity

- Status: **Proposed — Phase A (design) only. Not approved for implementation.** Per the brief, this document stops for review before any matching-pipeline code is written.
- Date: 2026-07-25, revised 2026-07-27 (Keppel-project grounding, explicit Principle 1/2 framing, Principle 2 verification findings added per follow-up brief).
- Audits/data this ADR is based on: `docs/audit/0002-identity-and-evidence-integrity-audit.md` (Follow-up Fixes 2 and 3), the 2026-07-25 live-data grounding pass (Kohler-only, §5), and a new 2026-07-27 grounding pass against the Keppel project's raw uploaded workbook (§4) and the current `/recommend` code path (§3).

## 1. The two governing principles (hard requirements for this design)

### Principle 1 — never average across a differentiating attribute

If two historical entries differ in **material, shape, or product-subtype**, they are different products, full stop. They must never be blended into a mean and must never share a rate. Averaging/blending across multiple historical rates is only legitimate when every identity-defining attribute is **confirmed identical** between the source entries (genuine repeat quotes for the exact same product) — and even then, a single most-relevant historical rate (closest project match, or an item's own literal twin) is preferred over a synthetic blended number, consistent with this project's standing "evidence drives recommendations, never a derived average" rule (§5 of prior work; `ProjectCalibrationEngine`'s `selectHistoricalEvidence` already selects, never blends, at the *evidence-pool* level — this ADR's job is to stop *materially different products* from ever entering the same pool in the first place, at both retrieval time and ingestion/clustering time).

The taxonomy in §6-§7 is designed so "same product identity" becomes a **strict equality check** across identity-defining attributes once they're extracted — not a similarity score that can be outvoted by shared surrounding text. §7.4 states the exact mechanical rule.

### Principle 2 — project-profile fields select the comparison pool, they never scale an item's rate

Cost/size/type/city/grade exist only to pick the right historical **project(s)** to compare against, so item-level matching happens against the right evidence pool. They must never scale or otherwise directly influence an individual item's rate. §3 below is the verification of this principle against the *current* code (not its comments) — required by the brief before Phase B, because the prior Kohler 41%-similarity incident (Audit 0002 §1) was exactly a Principle-2 violation in practice (a fabricated project profile silently driving real pricing decisions via a downstream multiplicative effect on `overallMatchScore`).

**Bottom line, stated up front: the core claim of Principle 2 holds in the code as it exists today — cost/size/city/grade demonstrably never multiply or rebase a rate anywhere in the pricing chain.** But the verification below found a real, live gap in the *machinery that decides which values these fields hold in the first place* (§3.4) — not a violation of Principle 2's rule, but a hole in guaranteeing the rule's inputs are trustworthy, which is what actually caused the Kohler incident. This needs a decision before Phase B per the brief; it is not fixed in this document.

## 2. Context

Three confirmed bugs, all in `docs/audit/0002-identity-and-evidence-integrity-audit.md`, share one root shape: a word or number that determines whether two BOQ line items are the *same commercial product* gets outvoted by the surrounding shared vocabulary, because "are these the same product" is currently decided by **text similarity** (`calculateWordOverlap`, `wordOverlapScore`, `isCommerciallyEquivalent`'s curated-but-partial qualifier list) rather than by **comparing what the item structurally is**.

- **Follow-up Fix 2**: "Counter Size 01-850mm H 750mm D 1500mm L" (₹55,000) merged with "...3290mm L" (₹85,000) at ingestion — 3 of 4 shared numeric tokens outvoted the one that mattered. Fixed by requiring exact numeric-token agreement.
- **Follow-up Fix 3**: "Curve Single Glazed Partition" (₹12,500) merged with "Single Glazed Partition" (₹5,500) — shared word overlap (3 of 4 words) outvoted the one word that mattered, and the codebase's own equivalence gate (`isCommerciallyEquivalent`) was never even consulted at the point identity is formed. Fixed by extending the qualifier vocabulary *and* wiring the gate into clustering.
- **This ADR's trigger**: both fixes were narrow, curated patches — a numeric-guard threshold, a hand-added word list. The Keppel-project grounding pass in §4 found **eight** more live instances of the same failure class in a single project alone (not the word-overlap threshold's fault every time — one of the eight, §4.7, is a strictly worse failure: the ingestion parser never even puts the distinguishing text into the description field for the clustering logic to compare). Patching one word/threshold at a time will keep recurring, because the underlying decision procedure is still "does the text look similar," never "do the structural facts match."

**A prior, independent attempt at this exact idea already exists in the codebase and already failed the same way.** `src/types.ts`'s `ItemDecomposition.commercialScope` (`"Supply and Installation"` / `"Supply Only"` / `"Installation Only"`) and `server.ts`'s `decomposeBOQItem` are precisely a categorical-attribute mechanism — but its detection is a short, hardcoded phrase list (`d.includes("supply only")`, `d.includes("installation only")`) that doesn't match the real vocabulary in the data (`"Installation of X"`, not `"installation only"`). Verified empirically (§5.5): it silently fails on all 10 live Kohler cases where this attribute actually matters, and a *different*, purely proportional 70/30 supply/install split (`server.ts` ~line 999) papers over the failure without anyone noticing. §4.8 below finds the Keppel project has its own, differently-worded scope-of-work failure (`"(NEW/PROPOSED)"` vs. `"(TO BE RELOCATED)"`), confirming a hand-picked phrase list can't even cover one project's full vocabulary, let alone generalize across two. This is direct evidence for the core decision below: **a hand-picked word list is not a mechanism, it's a snapshot of whichever bugs have been reported so far.**

## 3. Principle 2 verification — findings (required before Phase B)

This section traces `projectCost`/`projectSize`/`projectType`/`city`/`buildingGrade` end-to-end through the live code, per the brief's explicit instruction not to assume from comments.

### 3.1 Where the fields are actually used — confirmed pool-selection only, never rate scaling

Grepped every file in `src/` that reads these five fields:

- **`RecommendationEngineV2.getSimilarProjects`** (`src/RecommendationEngineV2.ts:44-99`) — the only place `cost`/`size`/`city`/`type`/`grade` are scored against historical projects, producing the Stage-1 Top-5 shortlist. `city` is also threaded into `recommendItem`'s signature (line 124) but is **never read inside the function body** — grep confirms the only other appearance of `city` in that file is inside a comment ("no city re-basing applied"). Confirmed: this function computes a similarity score for *project selection only*.
- **`ProjectCalibrationEngine.selectHistoricalEvidence`** (`src/ProjectCalibrationEngine.ts:270-333`, via `filterHistoricalEvidence` at line 219) — `buildingGrade` (as `currentGrade`) is used exactly once: to **exclude** evidence from a Premium/Luxury-graded historical project when the current target isn't itself Premium/Luxury (`filterHistoricalEvidence:227-262`, `"Premium/Luxury Project"` rejection reason). This is a pool-membership filter, not a multiplier — the surviving rate is used verbatim (`selected.rate`, line 346), never scaled by grade.
- **`HistoricalRetrievalEngine`** (`src/HistoricalRetrievalEngine.ts:170-180`) — `buildingGrade` feeds `deriveProjectGrade`, used the same way (a filter/scoring input for which *candidates* qualify, not a rate multiplier).
- No file anywhere in `src/` multiplies, rebases, or otherwise arithmetically combines `projectCost`/`projectSize`/`city`/`buildingGrade` with a `recommendedRate`/`unitRate`/historical rate value. (The old per-city rate multiplier, `getLocationFactorForCity`, was removed entirely in an earlier session — confirmed still absent.)

**Conclusion: Principle 2's core rule is genuinely implemented, not just commented.** Project-profile fields demonstrably only ever (a) rank/shortlist historical projects, or (b) filter which historical project's evidence is eligible for an item — never scale a price.

### 3.2 The precedence chain that feeds these fields (`server.ts:4176-4218`)

```
Parameter precedence: explicit request body > identified historical twin's real
profile > the RFQ's own projectContext > placeholder default.
```

`server.ts` normalizes the uploaded RFQ's name/filename and looks it up against `historicalBOQs` (`normalizeProjectIdentity`, `server.ts:4185-4195`) to find a `knownHistoricalTwin` — this is the Audit-0002 fix for the Kohler 41% incident: if the RFQ is a re-upload of a project already in the historical database, its *real* cost/size/city/type are available as a fallback (`twinCost`/`twinSize`/`twinCity`, `server.ts:4203-4205`) so a profile-less request no longer silently compares against the ₹1.5 Cr/50,000 sq ft/Delhi NCR/Commercial Office placeholder. This mechanism is real, correct, and exercised whenever the request body omits a field.

### 3.3 The frontend "Configure Project Profile" modal — the only call site

Grepped every frontend call to `/api/rfqs/:id/recommend` — there is exactly **one**, `src/components/RecommendationsTab.tsx:402`, inside `runEstimationEngine`, which is only ever invoked from `handleProfileSubmit` (`RecommendationsTab.tsx:431-470`), the "Configure Project Profile" modal's form submit handler. That handler **requires and validates all five fields before it will submit** (`RecommendationsTab.tsx:435-454` — Project Cost, Size, Type, City, Building Grade are all `required`, and the request body always carries a parsed value for each, never `undefined`).

The modal's own copy currently claims: *"These fields scale rates dynamically based on project cost, size, typology, and city"* and *"Determines local labor and material city scaling factor"* (`RecommendationsTab.tsx:2711`, `2796`). **Both statements are false as code** — Principle 2 and §3.1 confirm none of these fields ever scale a rate. This is the same class of stale/misleading UI copy previously found and removed for the "Historical Replay Detected" banner (which claimed "AI model calls bypassed" when nothing in the code actually did that) — flagged here, not fixed, since copy changes are UI work outside Phase A's design-only scope, but it should be corrected alongside whatever Phase B does.

### 3.4 The live gap: the twin-profile fallback is currently unreachable from the UI

This is the substantive finding. Walking the precedence chain against the one real call site:

1. `openProfileModal()` (`RecommendationsTab.tsx:385-398`) pre-fills the modal **only from `rfqDetails?.projectContext`** — the RFQ's own already-parsed metadata from upload time. It does **not** perform its own twin lookup against `historicalBOQs`. If `projectContext` has no usable cost/size (e.g., the uploaded workbook's preamble didn't parse cleanly, or this is the RFQ's first-ever `/recommend` call), the modal silently falls back to its hardcoded defaults: `"15000000"` / `"50000"` / `"Commercial Office"` / `"Gurgaon"` / `"Grade A"` (`RecommendationsTab.tsx:378-382`) — visually indistinguishable in the form from a real extracted value.
2. The user submits the form (required fields, can't submit empty) — `handleProfileSubmit` always sends `projectCost`/`projectSize`/`projectType`/`city`/`buildingGrade` as explicit values in the request body.
3. Per §3.2's own precedence order, **explicit request body always outranks the identified historical twin's real profile.** The twin-fallback tier (`twinCost > 0 ? twinCost : ...`, `server.ts:4214-4217`) is real, correct code — but with the one real UI call site always supplying a body, it is **provably unreachable in current usage.** There is no code path today where a live `/recommend` call omits these fields and lets the twin fallback activate.
4. The frontend has **no visibility into `knownHistoricalTwin` at all** — grepped `src/` for "twin"/"Twin": the only match is inside `ProjectCalibrationEngine.ts`'s own comments. Nothing tells the estimator "this looks like a re-upload of project X, here's its real profile" the way the old (now-removed, for unrelated pricing-shortcut reasons) replay-detection banner used to.

**Net effect:** the exact mechanism that closed the Kohler 41%-similarity gap (Audit 0002 fix 1) is correct in isolation but is currently dead code from the UI's perspective — it only helps a caller that calls the API directly without a body (e.g. a script, or the debug/regression harness), not an estimator using the product. For a first-time upload whose workbook preamble doesn't parse cleanly, the flow is: modal shows placeholder-looking defaults → user submits them, possibly without realizing they're not real → those values permanently outrank whatever the real historical twin (if one exists, including *this same project on a later re-run*) would have supplied, because they arrive as an explicit body value that the precedence chain is designed to trust as authoritative user input.

**This is a definitive finding, not an assumption, per the brief's request** — the twin real-profile fallback is a live, currently-provably-unreachable code path given exactly one call site and its always-populated body. It is flagged here for a product decision before Phase B (§9, open question 5): either (a) have `openProfileModal` itself look up the twin and clearly pre-fill/label real vs. placeholder values, (b) let the modal be skippable/fields-optional so an omitted field genuinely reaches the twin-fallback tier, or (c) invert precedence so a confidently-identified twin outranks a body value the user never actually edited from its pre-filled default — a UX/precedence decision, not something this document decides unilaterally.

## 4. Data grounding — Keppel project (new for this revision)

Per the brief's instruction, this section uses the Keppel project's **raw uploaded workbook** (`historical_sheets_store/hist_5qqjvg6gr.json`, 27 worksheets, historical BOQ id `hist_5qqjvg6gr`, "Keppel Final BOQ 30 Dec 2025 8", 8.75 Cr) as an additional, independent real-data source — not just `master_boq_store.json`'s already-clustered view, and not just Kohler.

### 4.1 Locating the domains

Keppel's own `domains` list (`historical_boqs_store.json`) adds several categories not present in the Kohler-only sample used in the original (2026-07-25) grounding pass: `Mist Cooling`, `White Goods`, `Gym Equipments`, `Dishwash Area`, `Multipurpose Hall`, `Stage 1st Floor`, `Gas Connection`, `Planters`, `Chairs`, `Makelist` — confirming the earlier finding (§5.1 below) that the real `domain` vocabulary keeps fragmenting with every new project ingested, reinforcing the taxonomy's head-noun-first design rather than a `domain`-keyed one.

### 4.2 Method

Scanned every master in `master_boq_store.json` whose `historicalRates` and `projects` arrays are **wholly attributable to the Keppel project** (i.e., not mixed with other projects' evidence), where `averageRate`/`medianRate` equals the exact arithmetic mean of two-or-more `historicalRates` — the diagnostic signature of a silent merge-then-blend, per the pattern already established in Follow-up Fixes 2 and 3 and reused directly from the brief's own worked example. 28 such masters exist. Most (the electrical cable cross-sections, duct/pipe diameter callouts) are **legitimate** — identical spec on both sides, genuine repeat-quote price variance, exactly the case Principle 1 says *is* fine to treat as one product (see §4.9). **Eight are not**: a material, subtype, mount-type, or construction-method word differs between the merged entries, and/or (worse, in one case) the differentiating information was never captured in the description at all.

### 4.3 Wooden vs. steel lockers — the brief's own worked example, confirmed exactly

`mstr_m4uuu3745` (domain `C&I`):
```json
"historicalDescriptions": [
  "Steel :\nProviding and fixing modular locker units in CRCA steel, complete with locks and numbering as per requirement.\nSize : 450mm x 450mm x 300mm",
  "Wooden :\nProviding and fixing modular locker units in ply with laminate finish, complete with locks and numbering as per requirement\nSize : 450mm x 450mm x 300mm"
],
"historicalRates": [2660, 2185],
"averageRate": 2422.5, "medianRate": 2422.5
```
Matches the brief's cited figures exactly (₹2,660 steel + ₹2,185 wooden → ₹2,422.50). Identical dimensions on both sides (numeric guard doesn't fire); "steel"/"wooden" aren't in `isCommerciallyEquivalent`'s vocabulary. **Category: material.**

### 4.4 Metal False Ceiling vs. Metal Baffel Ceiling

`mstr_eb3l5lfsz` (domain `C&I`): "Metal False Ceiling" (₹5,400) and "Metal Baffel Ceiling" [sic, source data's own spelling of "Baffle"] (₹2,900) → averaged to ₹4,150. These are two structurally different ceiling systems (a reflective suspended-panel system vs. a slat/baffle system) sharing "Metal" and "Ceiling" — 2 of 3 words — comfortably above the clustering threshold. **Category: product subtype / construction method.** Directly matches the brief's named example.

### 4.5 Ceiling Speaker vs. Surface Mounted Speaker

`mstr_e32vrhpkg` (domain `Pa` — Public Address): "...6W **Ceiling** Speaker..." (₹1,450) and "...6W **Surface Mounted** Speaker..." (₹3,000) → averaged to ₹2,225, a >2x spread. Same spec (6W, SPL, frequency response, tappings) otherwise identical. **Category: mount type** — corroborates the mount-type attribute family already proposed for Electrical in the original grounding pass (§6.1), now confirmed to recur in a second domain (PA) with independent vocabulary ("surface mounted" vs. the Electrical sample's "surface mount"/"flush mount").

### 4.6 Rectangular Table vs. Side Table

`mstr_6k6d5blxv` (domain `Interior`): "Rectangular Table" (₹11,250) and "Side Table - Rectangular" (₹6,210) → averaged to ₹8,730. "Rectangular" is shared; "Side Table" (a smaller, functionally distinct furniture category from a general/dining-scale rectangular table) is the actual differentiator and is outvoted. **Category: product subtype.**

### 4.7 Six "Pipeline" rows, Mist Cooling sheet — an ingestion-time failure, not (only) a matching-threshold failure

This is the most architecturally significant finding, and it changes a design assumption in the original (2026-07-25) draft.

Raw sheet dump, `historical_sheets_store/hist_5qqjvg6gr.json`, sheet `"BOQ - Mist Cooling"`:

| SL | ITEM DESCRIPTION cell | Rate (₹/Mtr) | The *only* distinguishing text (adjacent row, same column) |
|---|---|---|---|
| 2 | "Pipeline" | 523 | "Stainless Steel (S.S) 304 polished pipe 3/8" - with bush on every 2.5 ft." |
| 3 | "Pipeline" | 466 | "...3/8" - with bush on every 1 mtr." |
| 4 | "Pipeline" | 304 | "...3/8" plain pipe" |
| 5 | "Pipeline" | 361 | "...1/2" plain pipe" |
| 6 | "Pipeline" | 105 | "Imported Nylon...high-pressure pipe size 3/8''" |
| 7 | "Pipeline" | 1,425 | "High pressure Nylon hose 1/2" - 2 mtr. with fittings" |

The `LOCATION` and `BASIC RATE` columns are blank for every one of these rows — the diameter (3/8" vs. 1/2"), material (Stainless Steel vs. Nylon), and product form (pipe vs. hose) genuinely exist **nowhere else in structured form**; they live only in that adjacent continuation row.

**Root cause confirmed by tracing the actual ingestion code** (`server.ts`'s `POST /api/historical-boqs` row loop, `server.ts:2256-2397`): the loop inspects each row independently, with no lookahead/lookback to a neighboring row. A continuation row (no SL NO, no parseable rate) is classified `isHeaderRow` (`server.ts:2273-2288`) and is either misfiled into `currentHierarchy` (if short) or **dropped entirely** — its text is never appended to the preceding item's `standardDescription`/`historicalDescriptions`. Confirmed in `master_boq_store.json`: all six rows collapsed into one master, `mstr_ooi8ptodz`:
```json
"standardDescription": "Pipeline",
"historicalDescriptions": ["Pipeline","Pipeline","Pipeline","Pipeline","Pipeline","Pipeline"],
"historicalRates": [523, 466, 304, 361, 105, 1425],
"historicalSpecifications": [],
"keywords": ["pipeline"]
```
a 13.5x rate spread (₹105–₹1,425) blended to `averageRate: 530.67`, with the continuation-row text appearing **nowhere** in the record — not even as unused specification text a smarter matcher could someday read.

**Why this matters for the design, not just as an eighth bug instance**: every mechanism proposed in the original draft (stoplist, head-noun extraction, rate-correlation discovery) operates on "the description text of the row." That is not always where the identity-bearing text lives. §7.0 (new) makes multi-row description assembly an explicit prerequisite step, ahead of attribute extraction, not an assumption baked into the extraction step itself.

### 4.8 Fire/heat detector — scope-of-work, a second live instance with new vocabulary

`mstr_04h2ysvuu` (domain `Fa` — Fire Alarm): three entries merged —
```
"...(NEW/PROPOSED)"              → ₹4,500  (smoke detector, new supply+install)
"...(TO BE RELOCATED)"           → ₹700    (smoke detector, removal+reinstall)
"...Heat detector...(TO BE RELOCATED)" → ₹700 (heat detector, removal+reinstall)
```
averaged to ₹1,966.67. This blends two different scope-of-work classes (new install vs. remove-and-relocate — a 6.4x rate difference, since relocation reuses an existing device) using **different phrasing** (`"(NEW/PROPOSED)"` / `"(TO BE RELOCATED)"`) than the Kohler Toilet Works pattern that motivated `commercialScope` (`"Supply and installation of"` / `"Installation of"`, §5.5). This is exactly the generalization risk called out in §2: a hand-picked phrase list tuned to Kohler's vocabulary would still miss this Keppel instance. Reinforces §7.3's rate-correlation discovery approach over any fixed phrase list, and reinforces that scope-of-work detection needs to key off a *classified pattern* (leading/trailing scope tag), not a literal string match.

### 4.9 Four White Goods "game tables" — worse than word-overlap, because the words ARE already distinct

`mstr_xzh5c2m9l` (domain `White Goods`), sheet `"BOQ - White Goods"`, rows 5/8/11/14:
```json
"historicalDescriptions": [
  "Fooseball Table with Accessories",
  "Pool Table with Accessories",
  "Table Tennis Table with Accessories",
  "Carrom Table with Accessories"
],
"historicalRates": [28310, 69825, 28975, 5795],
"averageRate": 33226.25
```
Unlike the Mist Cooling case, the differentiating word (Fooseball/Pool/Table Tennis/Carrom) **is already present** in the head of the description — this is a pure word-overlap-threshold failure (3 of 4 words shared: "Table", "with", "Accessories"; 1 of 4 differs), the same failure shape as curve/flat glazing, just with a 12x rate spread instead of 2.3x — the most severe blended distortion found in either project's grounding pass. Confirms the taxonomy needs the differentiating word recognized as the **head noun's qualifier**, not stripped as boilerplate — "Table with Accessories" is the boilerplate; "Fooseball"/"Pool"/"Table Tennis"/"Carrom" is the identity-bearing prefix. This is exactly what §7.1's head-noun/candidate-word split is designed to do, cited here as a second, independent (recreation-equipment, not fabrication/shape) validation of that mechanism.

### 4.10 Single-leaf vs. double-leaf doors — confirmed as a *latent*, not currently *live*, risk in Keppel data

The brief names this as a confirmed cross-project failure class. Searched Keppel + catalog-wide for a same-dimension single-leaf/double-leaf merge: **none found currently live.** Keppel's leaf-count variants happen to also differ in dimension (`mstr_b3f79adnd`, single leaf, 1000×2400mm vs. `mstr_95zjoed8y`, double leaf, 1500×2400mm) — so Follow-up Fix 2's numeric guard incidentally keeps them apart today, **not** because leaf-count is a recognized categorical attribute. Confirmed: `"leaf"`/`"single leaf"`/`"double leaf"` are **not** in `isCommerciallyEquivalent`'s `DISTINGUISHING_QUALIFIERS` list (`src/EngineeringAdjustmentEngine.ts:167-187`) — if a future upload contains a same-dimension single/double-leaf pair (plausible; Kohler's own D1-D4 door types show leaf-count and dimension can vary independently, e.g. D2 is 1000mm single-leaf, D4 is 1800mm "Single Leaf...Double Door"), it would merge exactly like the ceiling/speaker/table cases above. **Recorded as a confirmed taxonomy gap and live risk, not a confirmed live merge** — the honest distinction matters for scoping Phase B correctly. (Separately, within the leaf-count-correctly-separated Keppel masters, a *different* real merge was found: `mstr_b3f79adnd` blends a laminate flush door with a glass-stiled door of the same nominal leaf-count and size, ₹22,000 vs. ₹42,000 — a **material** conflation, not a leaf-count one; `mstr_95zjoed8y` shows the identical pattern at the double-leaf size, ₹40,000 vs. ₹75,000.)

### 4.11 Summary table — Keppel-project categorical merges found

| # | Master | Merged variants | Rates → blended | Attribute category |
|---|---|---|---|---|
| 1 | `mstr_m4uuu3745` | Steel / Wooden locker | 2660 / 2185 → 2422.5 | Material |
| 2 | `mstr_eb3l5lfsz` | False / Baffel ceiling | 5400 / 2900 → 4150 | Product subtype / construction method |
| 3 | `mstr_e32vrhpkg` | Ceiling / Surface-mounted speaker | 1450 / 3000 → 2225 | Mount type |
| 4 | `mstr_6k6d5blxv` | Rectangular Table / Side Table | 11250 / 6210 → 8730 | Product subtype |
| 5 | `mstr_ooi8ptodz` | 6x "Pipeline" (diameter/material/form all outside description) | 523/466/304/361/105/1425 → 530.67 | **Ingestion-time information loss**, not a text-similarity failure |
| 6 | `mstr_04h2ysvuu` | New-install vs. relocated smoke/heat detector | 4500/700/700 → 1966.67 | Scope of work (new vocabulary) |
| 7 | `mstr_xzh5c2m9l` | 4 distinct recreation game tables | 28310/69825/28975/5795 → 33226.25 | Product subtype (word-overlap threshold, not a stoplist gap) |
| 8 | `mstr_b3f79adnd` + `mstr_95zjoed8y` | Laminate vs. glass door, same leaf-count/size | 22000/42000 → 32000; 40000/75000 → 57500 | Material |

The brief cites "five" such cases; this grounding pass found eight materially-differentiated merges (plus one confirmed-latent leaf-count risk, §4.10) in Keppel alone. Reported as found, not forced to match the cited count — the discrepancy itself is useful evidence that a full-catalog scan surfaces more than any hand-inspection would, which is the entire argument for §7.3's data-driven discovery mechanism over manual curation.

### 4.12 Kohler — "custom scope-of-work" vs. "simple catalog fitting," a new attribute-taxonomy category (not a merge/clustering bug)

A different failure shape from all of §4.1–§4.11, found in the ₹1,354.82 synthetic-rate investigation (`docs/audit/0002-identity-and-evidence-integrity-audit.md`'s "Follow-up Fix 5"), reported here per that investigation's explicit instruction to fold it into this taxonomy rather than patch it as a one-off. Two Kohler PHE items — "Lifting Station Outlet Pressurised Line" (bespoke 50mm CPVC/GI pressurised line with check valve + isolation, full engineering description) and "Lifting Station Power + Alarm Wiring" (bespoke 230V supply + BMS alarm relay wiring) — were reported matched to ₹216, a real historical rate but for an unrelated small-diameter pipe/fitting item. This is not a clustering/merge defect (no master merges these); it is a **retrieval-time risk category**: a complex, custom, one-off scope-of-work item, written as a full bespoke engineering spec rather than a catalog-style short description, has no true historical twin for its *specific* sub-scope, and weak text similarity can let it drift onto a generic, simply-worded catalog fitting's rate instead of being recognized as having no real evidence at all. (This specific pair, re-tested live in this session, currently resolves correctly to an exact SKF Phoenix twin instead — see the audit doc for the non-reproducibility note; the category of risk is the point, independent of whether this one instance is still live.)

This does not fit cleanly into the shape/subtype/material/mount-type/scope-of-work families above — it is not "two products conflated by a shared word," it is "a custom, multi-clause scope description with no true catalog equivalent, at risk of matching *something* rather than correctly matching *nothing*." Proposed as its own signal for §7.4's matching rule, additive to the taxonomy: when an item's description is long/multi-clause/bespoke (heuristically: several independent technical clauses — capacity, make, connection spec, included sub-components — rather than a single product-plus-dimension line) and its best surviving candidate's structural-attribute match is only partial or its head-noun/product-subtype is generic (e.g. "pipe," "wiring," a catalog fitting), that should lower confidence or force Manual Pricing rather than accept the match on text-similarity score alone — the inverse problem from §4.9's game tables (there, real distinguishing words got outvoted; here, a genuinely distinguishing *scope of complexity* has no word-level signal at all, only description length/structure). Not resolved into a concrete mechanism in this document — flagged as an open question for Phase B scoping (§9, question 8).

## 5. Data grounding — Kohler project (from the 2026-07-25 pass, retained)

### 5.1 Real domain list

The master catalog (`master_boq_store.json`, 1,907 items as of this writing) has **54 distinct `domain` values**, not the four canonical `Domain` enum values (`Civil`/`Interior`/`Electrical`/`Mechanical`) the core pricing enum uses — many are raw worksheet-name artifacts from specific project uploads (`Fps`, `Fa`, `Fas`, `Sf`, `Pas`, `Gss`, `C&i`, `C&i Boq R0`), not a controlled vocabulary. Top domains by item count:

| Domain | Masters | Domain | Masters |
|---|---|---|---|
| Electrical | 335 | Toilet Works | 77 |
| Mechanical | 274 | Passive Networking | 36 |
| Interior | 233 | Sanitary Fixtures | 29 |
| C&i | 116 | Vrf System | 27 |
| C&i Boq R0 | 109 | Fps | 26 |
| Civil | 87 | Chairs | 15 |
| Fire & Security | 85 | Modular Glass Partition & Doors | 11 |

**"Millworks," named as an example domain in the original brief, does not exist in the real data (0 items)** — the closest real analogs are `Interior` (furniture/joinery/counters) and parts of `C&i`/`C&i Boq R0`. §4.1's Keppel domain list (`Mist Cooling`, `White Goods`, `Gym Equipments`, etc.) adds further fragmentation on top of this. The taxonomy below is designed to key primarily off the extracted head-noun / product category, with `domain` used only as a coarse, best-effort scoping hint, never as a required exact-match key — a design that required exact domain agreement would itself be fragile against this real-world fragmentation.

### 5.2 The four original grounding bugs, verified against live data

| # | Bug | Live status verified | Category |
|---|---|---|---|
| 1 | AAC block thickness (100/150/200mm variants) | **Already correctly solved** — zero numeric-guard violations found in a full-catalog scan. Included as the *negative/reference* case: proof the existing numeric-vector mechanism (Follow-up Fix 2) must not be reinvented as a categorical attribute. | Numeric dimension — **out of scope** |
| 2 | Curve vs. flat glazing | **Fixed** (Follow-up Fix 3, `mstr_5vrogcnu2` / `mstr_xpbnvyuze`, still verified separate as of this revision: ₹12,500 / ₹5,500/₹4,500). Primary worked example for the "shape" attribute family. | Categorical — shape |
| 3 | Wet vs. Serving counter | **Still live, unfixed** (re-verified this revision): `mstr_kyhqyjgku` still holds both `"Tuk Shop Serving counter...1920mm L"` (₹175,000) and `"Tuk Shop Wet counter...1920mm L"` (₹200,000) as one master. | Categorical — product subtype |
| 4 | Tuk Shop counter L-dimension confusion | Traced to `EngineeringAdjustmentEngine.extractDescriptor` assigning `primaryDimension` **positionally** (first number found = H, constant across the family) rather than by which axis varies. Confirmed still positional as of the latest commit (`b5341f4`, "item mapping and dimensions check" — added a no-`x`-separator axis-letter regex tier, but `dim3DMatch[1]` is still always the first axis). Numeric-vector axis-identification problem — **explicitly out of scope for this ADR**, tracked separately. | Numeric dimension — **out of scope** |
| 5 | "Above Door Partition" vs. "Above Door/Glass Partition" (found 2026-07-28, `docs/audit/0002-identity-and-evidence-integrity-audit.md` Follow-up Fix 9) | `mstr_ebslegce6` merges SKF Phoenix's "Above Door Partition" (₹2,900) and Kohler's own "Above Door/Glass Partition" (₹3,450), 1.19x apart - same worksheet, same subcategory, **identical quantity (35 SQM)** in both source projects. Investigated and reported as **genuinely inconclusive from this single instance** - "glass" is not in `DISTINGUISHING_QUALIFIERS`, and the audit's own §7.3 bar (empirical correlation replicated across ≥2 masters/projects) can't be cleared by one occurrence pair whose ratio (1.19x) sits in the same range as both confirmed-real distinctions (Wet vs. Serving counter, row 3 above, only 1.14x) and ordinary coincidental cross-project variance elsewhere in the catalog. **Not promoted to a hard qualifier on this evidence alone** - carried here as a live candidate for material-class discovery once more occurrences exist. | Categorical — material class (candidate, unconfirmed) |

### 5.3 Numeric-guard integrity check (baseline for bug #1)

A full-catalog scan (every multi-occurrence master, comparing each occurrence's numeric-token set against its master's anchor) found **zero remaining violations** — the calibration proof that the existing numeric-vector mechanism is sufficient for pure-dimension distinctions and must not be duplicated inside the new categorical mechanism.

### 5.4 `commercialScope` — the existing, already-failed prior attempt

`decomposeBOQItem` (`server.ts` ~line 705) sets `commercialScope` via four hardcoded phrase checks that don't match the real recurring pattern in the data — Kohler's Toilet Works schedule uses `"Supply and installation of X ... Make: Jaquar/Kohler/Euronics or equivalent"` (supply+install) vs. `"Installation of X ... Make: Kohler"` (install-only), neither of which the four checks recognize, so both fall through to the same default and are treated as identical.

10 master items in Kohler show this exact phrasing split, e.g.:

| Master | Merged pair (supply+install vs. install-only) | Rates |
|---|---|---|
| `mstr_4ricaybwc` | Rimless wall-hung WC | ₹17,000 vs. ₹3,500 |
| `mstr_om5c93xsp` | Wall-mounted urinal | ₹10,500 vs. ₹2,350 |
| `mstr_9otzj57hw` | (health-faucet family) | ₹6,175 vs. ₹1,250 |
| `mstr_qyfun3xfr` | Nahani Trap | ₹1,473 vs. ₹300 |

`mstr_4ricaybwc`'s `precomputedSupplyRates`/`precomputedInstallationRates` are a flat **70%/30% split applied uniformly** to both rows — not derived from `commercialScope` at all, and wrong for the install-only row. §4.8's Keppel fire-detector case shows the *same* attribute (scope of work) failing again with entirely different vocabulary — strong, now cross-project, evidence that scope-of-work detection needs the data-driven approach in §7.3, not an extended phrase list.

### 5.5 Boundary/negative cases (should NOT trigger a categorical mismatch)

- **Brand names with "or equivalent"** (`"Make: Jaquar/Kohler/Euronics or equivalent"`, Sanitary Fixtures, and Keppel's own White Goods sample — every game-table spec ends "...Approved equivalent"). The explicit "or equivalent" phrasing is the BOQ author's own fungibility signal. Excluded from the categorical attribute set entirely (folded into the boilerplate stoplist).
- **Location/served-load labels** (Electrical DB panels: `"MAIN PANEL"`, `"HVAC PANEL"`, `"KITCHEN PANEL"`; Keppel's Mechanical AC-balancing entries by floor, `mstr_0fl0pncsb`: "1st Floor"/"Terrace Floor"/"Roof Top" — confirmed this revision as a second real instance of the same pattern). Project-specific instance names, not reusable product types — promoting these would explode the vocabulary without adding real identity information. **Never promote location/room/floor labels into the categorical set.**
- **Numbered style/variant IDs** ("Lounge chair 1"–"8"). Already handled correctly by the existing numeric-vector mechanism.
- **Boilerplate quality/approval phrases** ("1st Quality ISI approved", "as per architect's approval"). Near-universal presence means these fail §7.3's empirical correlation test automatically.
- **Genuine repeat quotes of an identical spec** — confirmed this revision as its own explicit boundary case, not previously called out: Keppel's electrical cable cross-section masters (e.g. `mstr_jmagzm6oc`, "3.5 core 240 sq. mm Al arm.", both source rows ₹3,073/₹3,050) and duct-diameter masters (e.g. `mstr_14oaigqsu`, "110 mm dia.", ₹600/₹750) are exact-arithmetic-average masters too — but **correctly so** under Principle 1, because nothing differs between the two source entries beyond ordinary quote-to-quote price variance for the identical product. These are the reference case for "when averaging is legitimate" and must not be broken by an over-eager categorical gate that starts treating natural rate variance as an identity mismatch.

## 6. Proposed taxonomy (illustrative — see §7.3 for how the full set is discovered, not hand-written)

**Modular Glass Partition & Doors** (Kohler: curve/flat glazing, D1-D4 door types; Keppel: no direct sample but confirms the leaf-count gap, §4.10):
- `shape`: curved | flat (default)
- `glazingType`: single glazed | double glazed
- `leafConfig`: single leaf | double leaf — **confirmed missing from the current qualifier vocabulary (§4.10); needed for Phase B, not yet a solved case.**
- `feature`: vision panel present/absent, sliding vs. hinged
- Dimensions (width × height) stay in the existing numeric vector, unchanged.

**Interior / furniture / recreation equipment** (Kohler: `mstr_kyhqyjgku` wet/serving, `mstr_fi0ivj12d` L-shape counter; Keppel: `mstr_6k6d5blxv` rectangular/side table, `mstr_xzh5c2m9l` game tables):
- `productSubtype`: Serving | Wet | Bain-Marie | Reception | Breakout | Handwash (counters); Lounge | Cabin | Booth | Training | Side (seating/tables); Fooseball | Pool | Table Tennis | Carrom (recreation) — the recreation-equipment sub-list is new evidence this revision that `productSubtype`'s vocabulary is domain-local and must be discovered per head-noun (§7.3), not written once as one flat list.
- `shape`: L-shape | Linear | Circular | Rectangular (default)
- `mountPosition`: under-counter | free-standing (default) | wall-mounted
- Dimensions stay in the existing numeric vector, unchanged.

**Ceilings** (new, Keppel §4.4): `constructionMethod`: false/suspended-panel | baffle/slat — a domain not represented in the original Kohler-only sample.

**Electrical / PA (speakers, fixtures)** (Kohler: fire exit signs; Keppel: `mstr_e32vrhpkg` speaker mount): `mountType`: surface mount | flush mount | recessed | ceiling — now confirmed to recur across two independent domains (Electrical, PA) with independently-worded vocabulary, strengthening the case for this as a genuinely cross-domain attribute rather than an Electrical-specific one.

**Toilet Works / Sanitary Fixtures — plumbing fixtures** (Kohler, §5.4): `scopeOfWork` (cross-domain — see below), `material/finish`, `modelCode` (SKU override, §7.5).

**Fire Alarm** (Keppel, §4.8): `scopeOfWork` again, with a second independent vocabulary pattern (`"(NEW/PROPOSED)"` / `"(TO BE RELOCATED)"`) — confirms `scopeOfWork` must be detected by *pattern class* (a leading or trailing scope tag, classified, not string-matched), not a fixed phrase pair.

**Civil** (AAC block wall variants, §5.3): no new categorical attributes — the calibration proof that pure-dimension variants are already correctly handled and must not be re-solved categorically.

### 6.1 Cross-domain attribute: scope of work

Already has a home in the type system (`ItemDecomposition.commercialScope`) but needs generalized detection: classify the description's leading/trailing scope phrasing into `SupplyInstall` / `InstallOnly` / `SupplyOnly` / `Relocate` (new, from §4.8) / `Unspecified`. This single attribute correctly separates 10 Kohler masters (§5.4) and at least 1 Keppel master (§4.8) — the largest single fix footprint of any attribute family found across both projects.

### 6.2 Tier-0 override: manufacturer model codes

Where a model-code-shaped token is present (alphanumeric segments joined by hyphens, ≥2 segments, at least one mixed letters+digits — e.g. Kohler's `"ACN-CHR-1161N"`), treat it as authoritative: same code ⇒ same product; different code ⇒ different product, regardless of surrounding text. Cheaper and more reliable than any word heuristic when available, costs nothing when absent.

## 7. Mechanism

### 7.0 Prerequisite, new this revision — multi-row description assembly

Per §4.7's finding, attribute extraction cannot assume the identity-bearing text is always inside the row that carries the SL NO / rate. **Before** boilerplate stripping or head-noun extraction runs, the ingestion parser (`server.ts`'s historical-BOQ row loop, currently `server.ts:2256-2397`) needs a lookahead step: when a row with a rate is immediately followed by one or more rows with no SL NO / no rate / no unit (today's `isHeaderRow` classification, `server.ts:2273-2288`), and those rows are not already claimed as a section subheading by the existing short-text/numeric-hierarchy logic, their text should be treated as a continuation of the preceding item's description and carried forward into the attribute-extraction pipeline (not necessarily displayed as the primary description everywhere — but available to §7.1-§7.4 as source text). This is a parsing-layer change, not a matching-algorithm change, and is scoped as its own Phase B work item (§9, open question 6) — it's called out here because it changes what "the description" means as an input to everything below it, which the original draft implicitly assumed was always fully present in one cell.

### 7.1 Domain-agnostic boilerplate stoplist

A shared stoplist strips known BOQ filler that carries no product-identity information, applied before any attribute extraction: `Providing`, `Providing and fixing`, `Supplying`, `SITC`, `as per`, `approved`, `approved make`, `manufacturer's specifications`, `complete in all respects`, `Make: <brand list> or equivalent`, drawing/spec references, etc. — empirically derivable from real data (the whole catalog's four most common leading tokens are `supply`/`supply,`/`providing`/`sitc`/`type`) rather than hand-guessed.

**Exception, deliberately carved out**: scope-of-work phrasing looks like boilerplate but is commercially load-bearing (§6.1) — stripped from the identity text but separately classified into `scopeOfWork`, not discarded.

### 7.2 Head-noun extraction

After boilerplate and numeric-dimension stripping (existing, unchanged), the last remaining significant noun in the stripped text is the head noun (`"partition"`, `"counter"`, `"ceiling"`, `"table"`, `"WC"`). A deliberately *broad* grouping key used only to scope the discovery analysis in §7.3, never to gate a live matching decision by itself. §4.9's game-table case shows why this must be paired with §7.3's per-head-noun candidate-word discovery rather than a flat cross-domain word list: "Table" is the head noun for four genuinely different products, and the differentiator ("Fooseball"/"Pool"/etc.) is a *prefix* qualifier local to that head noun, not a generic cross-domain shape/material word.

### 7.3 Data-driven categorical-attribute discovery (not a hand-picked word list)

1. **Candidate word pool**: for each head noun, across the whole catalog, collect every remaining significant word that appears in *some but not all* occurrences sharing that head noun.
2. **Empirical rate-correlation test**: for each candidate word, compare the rate of occurrences containing it against occurrences of the same head noun that don't, requiring (a) the rate ratio exceeds ~1.4x (the threshold that was itself discovered by running this kind of test during grounding, not chosen a priori — and validated again this revision: every one of §4's eight Keppel instances clears this threshold, from 1.24x (Wooden/Steel locker) to 12.06x (White Goods game tables)), and (b) the pattern replicates across ≥2 independent masters/projects. Words failing either test (near-universal presence, or no consistent price correlation) are automatically excluded.
3. **Slotting into named attributes**: words passing step 2 are grouped into human-named, human-reviewed attribute slots — a one-time calibration pass, but the *candidate list feeding it* is produced by a repeatable, re-runnable process over real data.
4. **Re-runnable, not frozen**: re-run whenever a new historical BOQ batch is ingested (Keppel's addition to the corpus this session is itself an example of exactly this — it surfaced 8 new candidate instances and 3 new attribute families — `constructionMethod`, cross-domain `mountType`, recreation-equipment `productSubtype` — that a Kohler-only pass could not have found).

### 7.4 The matching rule (structural identity — Phase B target, not implemented here)

Two items are the same commercial product identity **only if**:
- Model codes, if present on either side, match exactly; **else**
- Head nouns match (after light synonym normalization), **and** every categorical attribute detected on *either* side matches on both sides — an attribute undetected on one side is "unknown," not an automatic mismatch, mirroring `isCommerciallyEquivalent`'s existing "present in only one" convention generalized from presence/absence to attribute *values*.

No score, no threshold, no blending — a hard gate, evaluated once, before any similarity ranking or dimension math runs. This is the direct mechanical enforcement of **Principle 1**: once attributes are extracted, "same product" is strict equality, never a similarity score that a shared-boilerplate majority can outvote. Only after structural identity is confirmed do `wordOverlapScore`/`numericJaccard`/`overallMatchScore` (unchanged) rank among identity-equivalent candidates, and the dimension-vector mechanism (unchanged) handles interpolation/scaling within that identity — and §5.5's "genuine repeat quote" boundary case is exactly what falls through to that unchanged ranking/selection layer once attributes agree: `selectHistoricalEvidence` already selects a single best rate rather than blending (per Principle 1's second clause), so the electrical-cable/duct-diameter masters in §5.5 are correctly handled today and will remain so — this ADR only closes the gap where *different* products currently reach that same pool.

## 8. Consequences

- Replaces `isCommerciallyEquivalent`'s word-based heuristic as the primary equivalence gate (Phase B), rather than layering a fifth patch on top of it.
- Absorbs and finally makes good on `ItemDecomposition.commercialScope`'s original intent, now validated against two independently-worded projects (§5.4, §4.8).
- Does not touch `wordOverlapScore`/`numericJaccard`/`overallMatchScore`'s role for ranking among already-identity-matched candidates, or the dimension-vector interpolation mechanism.
- Adds a genuinely new ingestion-time step (§7.0, multi-row description assembly) that the original draft did not anticipate — without it, no amount of smarter matching logic can fix the Mist Cooling "Pipeline" class of bug, because the distinguishing text never reaches the matcher at all.
- Introduces a new piece of infrastructure (§7.3's discovery process) with no precedent in this codebase — Phase B should scope an initial, small, human-reviewed taxonomy (§6's domains) rather than attempt full automation on day one.
- Leaves Principle 2's core rule unchanged (it already holds, §3.1) but surfaces a concrete, needs-a-decision gap in how project-profile *inputs* are sourced (§3.4) — this is offered as a finding for product decision, not resolved by this document.

## 9. Open questions for review before Phase B

1. Does the §7.3 discovery mechanism (empirical rate-correlation over the real corpus) match the intended generality, or is a lighter-weight version (human-curated per domain, revisited each ingestion batch) preferred for a first cut?
2. Should `commercialScope`/scope-of-work (§6.1) ship as part of the same Phase B change, given it has the largest combined fix footprint (10 Kohler + 1 Keppel masters, two independent vocabularies) but is arguably a distinct concern from shape/subtype/material attributes?
3. Confirm the head-noun-as-primary-key design (§5.1, §4.1) over `domain`-scoped taxonomies, given both projects' domain-vocabulary fragmentation.
4. Confirm bug tracked in §5.2 #4 (Tuk Shop L-dimension / `primaryDimension` axis identification) stays explicitly out of this ADR's scope, tracked separately against the dimension-vector mechanism.
5. **Principle 2 finding (§3.4)**: how should the twin-detection real-profile fallback actually reach the pricing pipeline, given the Configure Project Profile modal's one call site always supplies an explicit body that currently outranks it? Needs a product decision (frontend twin lookup + labeling / optional fields / precedence inversion) — not decided by this document, and not itself a structural-attribute-matching change, but blocking full confidence that the original Kohler 41% incident's root cause (Audit 0002 §1) can't recur on a *different* project's first upload.
6. Scope of §7.0 (multi-row description assembly): is this bundled into the same Phase B change as attribute extraction, or landed first/separately as an ingestion-parser fix, given it's a different layer of the pipeline (parsing, not matching) and has its own regression risk (the existing `currentHierarchy` short-text subheading logic already reads these same "no rate" rows for a different purpose and must not be broken)?
7. The brief cited "five" exact-arithmetic-average cases in Keppel; this pass found eight (§4.11) plus one confirmed-latent risk (§4.10). Confirm this fuller count as the basis for Phase B scoping rather than the original five.
8. **§4.12's "custom scope-of-work" risk category**: is description length/structural-complexity a signal worth building into Phase B's matching rule (lowering confidence or forcing Manual Pricing when a bespoke multi-clause item's best candidate is only a generic/simply-worded catalog fitting), or is this adequately covered by the existing confidence/validation thresholds once §7.4's structural-identity gate is in place, without a dedicated new signal?

---

## 10. Addendum (2026-07-29): identity-INPUT corruption found upstream of the matcher — revises Phase B's prerequisites

This addendum records findings from the deployment-readiness pass. It materially changes what Phase B must assume, so read it before scoping any implementation.

### 10.1 A large share of "matching failure" was never a matching failure

This ADR (and the four preceding rounds of fixes) assumed the matcher received the correct item text and chose wrongly. For real uploaded workbooks that assumption was **false**.

`BOQParserEngine.detectColumnMap` resolved the description column by **leftmost header match**. Real commercial BOQs routinely carry two description-like columns — a short ALL-CAPS label and the full specification text. COWRKS is the live case (`B = "ITEM"`, `D = "DESCRIPTION"`), and the RFQ upload path extracted **column B** while `server.ts`'s historical-ingestion parser extracted **column D**. Identity was therefore compared across two entirely different strings for the same physical row.

Measured consequence, via controlled before/after on the real binary (`uploads/rfq_cm14qwsvs.xlsx`) through the real upload + recommend routes:

| Row | Real rate | Old parser's extracted identity | Result | After fix |
|---|---|---|---|---|
| C&I 351 | ₹11,550 | `"WET PANTRY CABINETRY AND COUNTER"` | collapsed | ₹11,550 (0.0%) |
| C&I 352 | ₹33,000 | `"WET PANTRY CABINETRY AND COUNTER"` (identical) | collapsed | ₹33,000 (0.0%) |
| C&I 64 | ₹1,100 | `"WATER PROOFING PLASTER"` | wrong match | ₹1,100 (0.0%) |
| C&I 342 | ₹207,900 | `"TYPE 1 - LINEAR FUEL BAR"` | wrong match | ₹207,900 (0.0%) |
| C&I 376 | ₹300,000 | `"RECEPTION TABLE"` | wrong match | ₹300,000 (0.0%) |

Rows 351 and 352 are two differently-priced products whose column-B labels are **byte-identical**. That is the mechanism behind the reported COWRKS ₹80,000/₹300,000/₹3,488 incident, and specifically explains *why the same numeric output appeared on multiple unrelated items* — the question left unanswered for the earlier ₹1,354.82 instance. It is an identity-**input** defect, not an identity-**resolution** defect, and no amount of structural-attribute matching downstream could have corrected it.

**Implication for Phase B**: the ADR's §7.0 ingestion prerequisite is confirmed and must be broadened. Attribute extraction cannot be specified against "the row's description text" until the pipeline agrees on *which cell that is*. Phase B should treat "both ingestion and upload resolve the same description column, by content not header order" as a hard precondition, now satisfied by `resolveDescriptionColumn`.

### 10.2 The self-replay harness structurally cannot detect this class of defect

`test_historical_replay.cjs` reconstructs each project's workbook from ground-truth mappings into a synthetic six-column layout with exactly **one** description column. Every structural property that causes the defects in this ADR — multi-description-column layouts, split Supply/Erection rate headers, merged group headers, continuation rows, formula-valued quantity columns — is erased by that reconstruction.

It reported **90.3% within 1%** across all six projects while real uploads of the same projects were catastrophically mis-identified, and it reported that number unchanged before and after the parser fix.

A second harness, `test_real_upload_replay.cjs`, was added: it uploads each project's **actual retained `.xlsx` binary** through the real routes, joins to ground truth by `(worksheetName, rowNumber)`, drives the real export route, and scans for repeated-constant fingerprints. **Phase B must be validated against this harness**; a green self-replay number is not evidence that the real upload path works.

### 10.3 Four further structural defects, all invisible to self-replay

Found and fixed in the same pass; each independently blocked or corrupted a whole project:

1. **ExcelJS cannot index comment parts** written as `xl/comments/commentN.xml` + `xl/drawings/commentsDrawingN.vml` (it only matches `xl/commentsN.xml`). Its lookup map stays empty while the worksheet still carries a Comments relationship, so reconcile dereferences `undefined` and the **entire workbook fails to load** — DHL Chennai fell through to the legacy fixed-position parser or failed upload outright.
2. **Blank quantity was treated as "section label"**. Keppel's `TOTAL QUANTITY` column is a formula with no cached value (real quantities live in per-floor breakdown columns), so **389 of 473 ground-truth rows (82%) were discarded**. The unit-of-measure cell is the correct discriminator: a priced BOQ line always carries one, a section label never does.
3. **Split Supply/Erection layouts** whose quantity column is headed just `"TOTAL"` classify as an amount, leaving quantity undetected and entire sheets skipped. Disambiguated structurally: an amount column never sits to the *left* of the rate column.
4. **A 50 MB Express body limit** rejected the real 79 MB Nuvama Hyderabad BOQ (100.3 MB base64) before any application code ran, returning an HTML error page that every client reported as `Unexpected token '<'`.

Ground-truth row coverage from real binaries, before → after: **76.5% → 96.6%** (529 → 80 rows never parsed), with Keppel 17.8% → 100%, DHL 0% (total failure) → 98.0%, Nuvama 0% (total failure) → 98.4%.

### 10.4 What this does *not* change

The core thesis stands, and the remaining deviations are now a **cleaner** signal for it, because the identity-input noise has been removed. Measured across all six real binaries after the parser fixes, the largest surviving cluster is exactly §5.2 #4's parent-hierarchy gap:

- **`mstr_ml0t3eb1f` "End terminations"** holds **22 historical rates spanning ₹120–₹2,200** in one master, with no parent context stored anywhere on `MasterBOQItem`. It produces ₹2,200 for **27 items on SKF Phoenix and 20+ on Kohler** — roughly 18% of all remaining >5% deviations across the suite, and the single largest identifiable cluster.
- Keppel's "Pipeline" rows (§4.x, non-description attributes) and the Wet/Serving counter subtype case remain live and unfixed.

**Phase B remains necessary and is not implemented.** Its highest-value first increment, on this evidence, is parent-hierarchy-aware identity (§5.2 #4 / Phase B item 5) rather than the shape/subtype vocabulary — note this requires a **master-catalog re-ingestion**, since `MasterBOQItem` currently persists no parent/context field at all and existing masters have already fused the distinction away.
