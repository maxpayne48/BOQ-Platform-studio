# ADR-0002: Structured Attribute Matching for Commercial Product Identity

- Status: **Proposed — Phase A (design) only. Not approved for implementation.** Per the brief, this document stops for review before any matching-pipeline code is written.
- Date: 2026-07-25
- Audit this ADR is based on: `docs/audit/0002-identity-and-evidence-integrity-audit.md` (Follow-up Fixes 2 and 3), plus new live-data grounding performed for this document (see §2).

## 1. Context

Three confirmed bugs, all in `docs/audit/0002-identity-and-evidence-integrity-audit.md`, share one root shape: a word or number that determines whether two BOQ line items are the *same commercial product* gets outvoted by the surrounding shared vocabulary, because "are these the same product" is currently decided by **text similarity** (`calculateWordOverlap`, `wordOverlapScore`, `isCommerciallyEquivalent`'s curated-but-partial qualifier list) rather than by **comparing what the item structurally is**.

- **Follow-up Fix 2**: "Counter Size 01-850mm H 750mm D 1500mm L" (₹55,000) merged with "...3290mm L" (₹85,000) at ingestion — 3 of 4 shared numeric tokens outvoted the one that mattered. Fixed by requiring exact numeric-token agreement.
- **Follow-up Fix 3**: "Curve Single Glazed Partition" (₹12,500) merged with "Single Glazed Partition" (₹5,500) — shared word overlap (3 of 4 words) outvoted the one word that mattered, and the codebase's own equivalence gate (`isCommerciallyEquivalent`) was never even consulted at the point identity is formed. Fixed by extending the qualifier vocabulary *and* wiring the gate into clustering.
- **This ADR's trigger**: both fixes were narrow, curated patches — a numeric-guard threshold, a hand-added word list. Four independent instances of the same failure class (enumerated in §2 below, including two discovered fresh during this document's own data-grounding pass, not assumed from the brief) show that patching one word/threshold at a time will keep recurring, because the underlying decision procedure is still "does the text look similar," never "do the structural facts match."

**A prior, independent attempt at this exact idea already exists in the codebase and already failed the same way.** `src/types.ts`'s `ItemDecomposition.commercialScope` (`"Supply and Installation"` / `"Supply Only"` / `"Installation Only"`) and `server.ts`'s `decomposeBOQItem` are precisely a categorical-attribute mechanism — but its detection is a short, hardcoded phrase list (`d.includes("supply only")`, `d.includes("installation only")`) that doesn't match the real vocabulary in the data (`"Installation of X"`, not `"installation only"`). Verified empirically (§2.5): it silently fails on all 10 live cases where this attribute actually matters, and a *different*, purely proportional 70/30 supply/install split (`server.ts` ~line 999) papers over the failure without anyone noticing. This is direct evidence for the core decision below: **a hand-picked word list is not a mechanism, it's a snapshot of whichever bugs have been reported so far** — the same critique this ADR's brief opens with, now demonstrated against existing code, not just hypothesized.

## 2. Data grounding (real data, not assumed)

### 2.1 Real domain list

The master catalog (`master_boq_store.json`, 1,907 items as of this writing) has **54 distinct `domain` values**, not the four canonical `Domain` enum values (`Civil`/`Interior`/`Electrical`/`Mechanical`) the core pricing enum uses. This was already flagged as a data-quality observation in Follow-up Fix 2 (not re-litigated here) — many domain values are raw worksheet-name artifacts from specific project uploads (`Fps`, `Fa`, `Fas`, `Sf`, `Pas`, `Gss`, `C&i`, `C&i Boq R0`), not a controlled vocabulary. Top domains by item count:

| Domain | Masters | Domain | Masters |
|---|---|---|---|
| Electrical | 335 | Toilet Works | 77 |
| Mechanical | 274 | Passive Networking | 36 |
| Interior | 233 | Sanitary Fixtures | 29 |
| C&i | 116 | Vrf System | 27 |
| C&i Boq R0 | 109 | Fps | 26 |
| Civil | 87 | Chairs | 15 |
| Fire & Security | 85 | Modular Glass Partition & Doors | 11 |

**"Millworks," named as an example domain in the brief, does not exist in the real data (0 items)** — the closest real analogs are `Interior` (furniture/joinery/counters) and parts of `C&i`/`C&i Boq R0`. This confirms the instruction to read the real list rather than assume: the taxonomy below is built only against domains that actually exist, and — because of the 54-vs-4 fragmentation above — **the taxonomy is designed to key primarily off the extracted head-noun / product category, with `domain` used only as a coarse, best-effort scoping hint, never as a required exact-match key.** A design that required exact domain agreement would itself be fragile against this same real-world fragmentation (e.g. two functionally-identical AAC block masters currently sit in `Civil`, `Toilet Works`, and `C&i` — see §2.5).

### 2.2 Domains selected for taxonomy development

Representative sample covering furniture/joinery, glazing, plumbing/sanitary, electrical, and civil — chosen because they contain the four grounding bugs plus enough volume (11–335 items each) to see real recurring vocabulary rather than one-off phrasing:

`Modular Glass Partition & Doors`, `Interior`, `Toilet Works` / `Sanitary Fixtures`, `Electrical`, `Civil`. `Mechanical`/`Vrf System`/`Fire & Security` are discussed in §2.6 as a boundary case (categorical layer is comparatively thin there; numeric capacity dominates).

### 2.3 The four grounding bugs, verified against live data

| # | Bug | Live status verified this session | Category |
|---|---|---|---|
| 1 | AAC block thickness (100mm/150mm/200mm variants) | **Already correctly solved** — zero numeric-guard violations found in a full-catalog scan (see §2.4). Included as the *negative/reference* case: proof the existing numeric-vector mechanism (Follow-up Fix 2) must not be reinvented as a categorical attribute. | Numeric dimension — **out of scope for this ADR** |
| 2 | Curve vs. flat glazing | **Fixed** (Follow-up Fix 3, `mstr_5vrogcnu2` / `mstr_xpbnvyuze` now separate, ₹12,500 / ₹5,500). Used as the primary worked example for the "shape" attribute family. | Categorical — shape |
| 3 | Wet vs. Serving counter | **Reproduced live, still unfixed**: `mstr_kyhqyjgku` currently holds *both* `"Tuk Shop Serving counter - Size -1050mm H X 750mm D X 1920mm L"` (₹175,000) *and* `"Tuk Shop Wet counter - Size -1050mm H X 750mm D X 1920mm L"` (₹200,000) as one master — identical dimensions on both sides (so Follow-up Fix 2's numeric guard doesn't fire), and neither "wet" nor "serving" is in `isCommerciallyEquivalent`'s vocabulary (so Follow-up Fix 3 doesn't fire either). This is genuinely a third, distinct failure instance — a **product-subtype** word, not a shape word or a number. | Categorical — product subtype |
| 4 | Tuk Shop counter L-dimension confusion | Traced to a **different, already-documented mechanism**: `EngineeringAdjustmentEngine.extractDescriptor`'s dimension extractor assigns `primaryDimension` **positionally** (always the *first* number found in text) rather than by identifying which axis actually *varies* across a family's reference points. For every Tuk Shop counter variant, the first number is always **H = 1050mm** (constant across the family) — so `HistoricalRetrievalEngine`'s `dimensionScore` reads every Tuk Shop counter as "same dimension" regardless of the true varying axis (L: 1920 / 2890 / 3000mm), even though (per bug #3) the masters are — or, once #3 is fixed, will be — correctly separated as distinct records. This was already flagged as residual debt in Follow-up Fix 2's audit notes ("primaryDimension still resolves positionally... left as known residual debt"). It is a numeric-vector axis-identification problem, not a categorical-identity problem — **explicitly out of scope for this ADR**, to be addressed by future work on the dimension-vector side. Cited here only as evidence that dimension confusion and categorical confusion are two genuinely different defects that happen to co-occur on the same item family, which is exactly why this ADR keeps them as separate concerns per the brief's instruction #2. | Numeric dimension (axis identification) — **out of scope for this ADR** |

### 2.4 Numeric-guard integrity check (baseline for bug #1)

A full-catalog scan (every multi-occurrence master, comparing each occurrence's numeric-token set against its master's anchor) found **zero remaining violations** — every master where a numeric token differs between occurrences has already been correctly split by Follow-up Fix 2's migration. This is the calibration proof that the existing numeric-vector mechanism is sufficient for pure-dimension distinctions and must not be duplicated inside the new categorical mechanism.

### 2.5 `commercialScope` — the existing, already-failed prior attempt (new finding this session)

`decomposeBOQItem` (`server.ts` ~line 705) sets `commercialScope` via four hardcoded phrase checks: `"excluding"+"reinforcement"`, `"excluding"+"centering"`, `"supply only"`, `"installation only"`/`"labor only"`, else a single default ("Supply, Laying, Fixing, Testing, and Commissioning..."). None of these phrases match the real recurring pattern in the data — Kohler's Toilet Works schedule instead uses `"Supply and installation of X ... Make: Jaquar/Kohler/Euronics or equivalent"` (supply+install, full Make list) vs. `"Installation of X ... Make: Kohler"` (install-only, single brand) — so both sides fall through to the *same* default `commercialScope` value and are treated as identical.

A full-catalog scan found **10 master items** where this exact phrasing split occurs (all currently in `Toilet Works`, all currently merged into one master each), for example:

| Master | Merged pair (supply+install vs. install-only) | Rates |
|---|---|---|
| `mstr_4ricaybwc` | Rimless wall-hung WC | ₹17,000 vs. ₹3,500 |
| `mstr_om5c93xsp` | Wall-mounted urinal | ₹10,500 vs. ₹2,350 |
| `mstr_9otzj57hw` | (health-faucet family) | ₹6,175 vs. ₹1,250 |
| `mstr_qyfun3xfr` *(already flagged, Follow-up Fix 3 residual notes)* | Nahani Trap | ₹1,473 vs. ₹300 |

Checked at the master-stats level too: `mstr_4ricaybwc`'s `precomputedSupplyRates`/`precomputedInstallationRates` are a flat **70%/30% split applied uniformly** to both the ₹17,000 and the ₹3,500 rows (`[11900, 2450]` / `[5100, 1050]`) — not derived from `commercialScope` at all, and obviously wrong for the ₹3,500 row (which *is* the installation-only rate, not 30% of some larger number). This is the same "arithmetic footprint of a wrong merge" symptom found in Follow-up Fixes 2 and 3 (`averageRate`/`medianRate` = the mean of two distinct real prices), now found a third time, inside a mechanism that already exists specifically to prevent it.

**This is included not as a bug to fix under this ADR, but as the strongest evidence for the ADR's core thesis**: hand-curated phrase/word lists (`commercialScope`'s four checks, `isCommerciallyEquivalent`'s original list, the numeric guard's original 0.5 threshold) all independently converged on the same failure mode — narrow coverage that looks reasonable against the bugs already known and silently fails against real, un-anticipated phrasing. **Scope-of-work (Supply+Install / Install-only / Supply-only) is proposed below (§3.4) as one of the categorical attributes, generalized across all domains, not just Toilet Works** — and `ItemDecomposition.commercialScope` is the natural field to extend in Phase B (the type already exists; only its detection mechanism needs replacing).

### 2.6 Boundary/negative cases (should NOT trigger a categorical mismatch)

Required by instruction #3, to sanity-check the taxonomy isn't overfit to the four bugs:

- **Brand names with "or equivalent"** (`Sanitary Fixtures`, pervasive: `"Make: Jaquar/Kohler/Euronics or equivalent"`). The explicit "or equivalent" phrasing is the BOQ author's own signal that any listed brand is commercially fungible for this line item. Brand should be **excluded** from the categorical attribute set entirely (folded into the boilerplate stoplist, §3.2), not treated as a mismatch signal — unless a future empirical pass (§3.3) finds a specific brand that reliably correlates with a price step *without* "or equivalent" phrasing, in which case that specific finding, not brand-in-general, would be promoted.
- **Location/served-load labels on Electrical DB panels** (`"MAIN PANEL"`, `"HVAC PANEL"`, `"KITCHEN PANEL"`, `"CAFETRIA DB"`, `"GYM AREA DB"` — all in the Electrical sample, §2.2). These look categorical but are project-specific instance names correlating with a *unique, one-off capacity/cost* per panel, not a reusable cross-project product type. Treating "Kitchen" vs "HVAC" as a categorical attribute would explode the vocabulary (unbounded location names) without adding real commercial-identity information — the panels' actual cost driver (capacity/rating) is a numeric dimension that this class of raw description often fails to capture explicitly (a parsing/data-quality gap, not a matching-architecture gap). **Recommendation: never promote location/room-name tokens into the categorical set.**
- **Numbered style/variant IDs** (`"Lounge chair 1"` through `"Lounge chair 8"`, `"Paint finish 1"`–`"4"`, `"Wallpaper Type 1"`–`"3"`, Interior/C&i Boq R0 samples). These are already handled correctly, as a side effect, by the existing numeric-vector mechanism (any numeric disagreement blocks clustering) — no new categorical handling is needed for this pattern; cited here as confirmation the numeric mechanism generalizes to "opaque identity numbers," not only to physical dimensions.
- **Boilerplate quality/approval phrases** (`"1st Quality ISI approved"`, `"as per architect's approval"`, `"of approved make"`, `"as per manufacturer's specifications"` — found in nearly every domain sampled). Near-universal presence means these would fail §3.3's empirical correlation test automatically (they don't co-occur selectively with a price step, because they're present almost everywhere) — cited as a built-in check that the discovery mechanism self-filters obvious filler without needing to be told in advance which phrases are filler.

## 3. Proposed taxonomy and extraction approach

### 3.1 Attribute categories, by domain (illustrative, not exhaustive — see §3.3 for how the full set is meant to be discovered, not hand-written)

**Modular Glass Partition & Doors** (grounded in: `mstr_5vrogcnu2`/`mstr_xpbnvyuze` curve/flat; `mstr_w9bdi2nno`…`mstr_dpc5lhj1t` D1–D4 door types):
- `shape`: curved | flat (default)
- `glazingType`: single glazed | double glazed
- `leafConfig` (doors): single leaf | double leaf
- `feature`: vision panel present/absent, sliding vs. hinged
- Dimensions (width × height) stay in the existing numeric vector, unchanged.

**Interior — counters & seating** (grounded in: `mstr_kyhqyjgku` wet/serving; `mstr_1am0ymtld` circular/plain high table; `mstr_fi0ivj12d` L-shape counter):
- `productSubtype`: Serving | Wet | Bain-Marie | Reception | Breakout | Handwash (counters); Lounge | Cabin | Booth | Training (seating)
- `shape`: L-shape | Linear | Circular | Rectangular (default)
- `mountPosition`: under-counter | free-standing (default) | wall-mounted
- Dimensions (H × D × L) stay in the existing numeric vector, unchanged.

**Toilet Works / Sanitary Fixtures — plumbing fixtures** (grounded in: the 10 masters in §2.5; `mstr_ybvlt96rw` etc.):
- `scopeOfWork` (cross-domain, not fixtures-specific — see §3.4): Supply+Install | Install-only | Supply-only
- `material/finish`: CP Brass | SS | uPVC | CPVC | cast-iron
- `modelCode` (when a manufacturer SKU pattern is present — see §3.5): treated as an authoritative override, bypassing text-based attributes entirely.

**Electrical** (grounded in: `mstr_oy65x487h`/`mstr_bbdl7kjyv` surface/flush mount fire exit sign; existing `fire rated`/`powder coated` qualifiers newly enforced at clustering per Follow-up Fix 3):
- `mountType`: surface mount | flush mount | recessed
- `material/finish`: galvanized | powder coated | stainless (already in `isCommerciallyEquivalent`, just needs the clustering-time enforcement Follow-up Fix 3 already added)
- Explicitly **not** categorical: served-load/room-name labels (§2.6).

**Civil** (grounded in: AAC block wall variants, §2.4):
- No new categorical attributes proposed here — this domain is the calibration proof that pure-dimension variants (thickness) are already correctly handled by the numeric mechanism and must not be re-solved categorically.

### 3.2 Mechanism, part 1 — domain-agnostic boilerplate stoplist

A shared stoplist strips known BOQ filler that carries no product-identity information, applied before any attribute extraction (the same principle `EngineeringAdjustmentEngine.extractDescriptor`'s `UNIT_STRIP_REGEX` already applies to units — generalized to filler *phrases*): `Providing`, `Providing and fixing`, `Supplying`, `Supply & fixing`, `Supply, Installing, testing and commissioning` / `SITC`, `as per`, `approved`, `approved make`, `manufacturer's specifications`, `complete in all respects`, `Make: <brand list> or equivalent` (the whole brand clause, per §2.6), drawing/spec references (`Dwg. No. XXXX`), etc. Empirically derivable from real data (§2 sampling already surfaced `supply`/`supply,`/`providing`/`sitc`/`type` as the four most common leading tokens across the whole catalog) rather than hand-guessed from scratch.

**Exception, deliberately carved out of the stoplist**: scope-of-work phrasing (`Supply and installation of` / `Installation of` / `Supply of` / SITC) looks like boilerplate but is exactly the signal §2.5 shows is commercially load-bearing — it is stripped from the *identity text* but its presence/absence is separately classified into the `scopeOfWork` attribute (§3.4), not discarded.

### 3.3 Mechanism, part 2 — data-driven categorical-attribute discovery (not a hand-picked word list)

This is the direct answer to instruction #4: don't hand-pick words, propose a mechanism that generalizes to vocabulary not yet seen.

1. **Head-noun extraction**: after boilerplate stripping (§3.2) and numeric-dimension stripping (existing, unchanged — `extractDescriptor`'s unit/dimension regexes), the last remaining significant noun in the stripped text is the head noun (`"partition"`, `"counter"`, `"chair"`, `"light"`, `"WC"`). This is a coarse, deliberately *broad* grouping key — broader than final clustering should ever be — used only to scope the discovery analysis below, never to gate a live matching decision by itself.
2. **Candidate word pool**: for each head noun, across the *whole* catalog (not scoped to one project), collect every remaining significant word that appears in *some but not all* occurrences sharing that head noun.
3. **Empirical rate-correlation test** (this is the part that replaces "hand-pick important words"): for each candidate word, compare the rate of occurrences containing it against occurrences of the same head noun that don't, requiring: (a) the rate ratio between the two groups exceeds a threshold (empirically, ≥1.4x was the cut used to surface real cases during this document's own §2 grounding scan — itself discovered by running exactly this kind of test, not chosen a priori); (b) the pattern replicates across **at least two independent masters or projects** (guards against one-off phrasing noise, mirroring the existing "extend the list if a new *recurring* mismatch class is found" convention already documented in `isCommerciallyEquivalent`'s code comment). Words that fail either test (near-universal presence, or no consistent price correlation — like the `"ISI approved"`/brand-name boilerplate in §2.6) are automatically excluded, without needing to be told in advance that they're filler.
4. **Slotting into named attributes**: words that pass step 3 are grouped into human-named, human-reviewed attribute slots (a curved/curve/radius cluster becomes `shape: curved`; wet/serving becomes `productSubtype`) — this final naming/grouping step is a one-time calibration pass by an engineer, same as today's `DISTINGUISHING_QUALIFIERS`, but the *candidate list feeding it* is now produced by a repeatable, re-runnable process over real data instead of by waiting for the next bug report.
5. **Re-runnable, not frozen**: proposed to be re-run whenever a new historical BOQ batch is ingested, surfacing new candidate words for review as the vocabulary in the data grows — the taxonomy is a living output of this process, not a document that goes stale.

### 3.4 Cross-domain attribute: scope of work

Unlike shape/subtype (domain-specific), **scope of work is a single, domain-agnostic categorical attribute** that already has a home in the type system (`ItemDecomposition.commercialScope`, §2.5) but needs generalized detection: classify the *leading phrase pattern* of a description (after light normalization) into `SupplyInstall` (`"Supply and installation of"`, `"Providing and fixing"`, SITC) / `InstallOnly` (`"Installation of"`, `"Fixing of"` when not preceded by `"Supply"`) / `SupplyOnly` (`"Supply of"`) / `Unspecified`. This single attribute would, on its own, correctly separate all 10 masters found in §2.5 — a materially larger fix footprint than the shape/subtype work, discovered as a byproduct of this grounding exercise.

### 3.5 Tier-0 override: manufacturer model codes

`Sanitary Fixtures` descriptions frequently embed a literal SKU (`"ACN-CHR-1161N"`, `"CNS-WHT-963UFSM"` — §2.2 sample). Where a model-code-shaped token is present (alphanumeric segments joined by hyphens, ≥2 segments, at least one segment with mixed letters+digits), it is proposed as an **authoritative identity signal that short-circuits every other check**: same code ⇒ same product regardless of surrounding text differences; different code ⇒ different product regardless of text similarity. This is cheaper and more reliable than any word-based heuristic wherever it's available, and costs nothing when absent (falls through to §3.1–3.4 as today).

### 3.6 The matching rule (structural identity — Phase B target, not implemented here)

Two items are the same commercial product identity **only if**:
- Model codes, if present on either side, match exactly; **else**
- Head nouns match (after a small synonym-normalization step — e.g. "counter" ~ "counter top"), **and** every categorical attribute detected on *either* side (shape, product subtype, scope of work, material/finish, mount type) matches on both sides — an attribute undetected on one side is "unknown," not an automatic mismatch, mirroring `isCommerciallyEquivalent`'s existing "present in only one" convention generalized from presence/absence to attribute *values*.

No score, no threshold, no blending — this is a hard gate, evaluated once, before any similarity ranking or dimension math runs. Only after structural identity is confirmed do `wordOverlapScore`/`numericJaccard`/`overallMatchScore` (unchanged) take over to rank among identity-equivalent candidates, and does the dimension-vector mechanism (unchanged, `extractDescriptor` + `EngineeringAdjustmentEngine`) handle interpolation/scaling across sizes within that identity — exactly the division of labor the brief specifies, and exactly why bug #4 (§2.3) is scoped out of this document.

## 4. Consequences (of adopting this direction — not yet implemented)

- Replaces `isCommerciallyEquivalent`'s word-based heuristic as the primary equivalence gate (Phase B), rather than layering a fourth patch on top of it.
- Absorbs and finally makes good on `ItemDecomposition.commercialScope`'s original intent (§2.5) instead of leaving it as a silently-failing parallel mechanism.
- Does not touch `wordOverlapScore`/`numericJaccard`/`overallMatchScore`'s role for ranking among already-identity-matched candidates, or the dimension-vector interpolation mechanism — both stay exactly as they are today, per the brief.
- Introduces a genuinely new piece of infrastructure (§3.3's discovery process) that has no precedent in this codebase yet — Phase B should scope an initial, small, human-reviewed taxonomy (the domains in §3.1) rather than attempt full automation on day one.
- The domain-fragmentation finding (§2.1) means Phase B's attribute schema should be keyed by head-noun, not by the 54 raw `domain` values — a design constraint this document surfaces but does not resolve (resolving the domain-vocabulary fragmentation itself is a separate, larger data-quality question, out of scope here).

## 5. Open questions for review before Phase B

1. Does the proposed §3.3 discovery mechanism (empirical rate-correlation over the real corpus) match the intended generality, or is a lighter-weight version (e.g. still human-curated per domain, but explicitly re-visited each ingestion batch) preferred for a first cut?
2. Should `commercialScope`/scope-of-work (§3.4) be implemented as part of the same Phase B change, given it's the largest-footprint finding from this grounding pass (10 masters) but is arguably a distinct concern from shape/subtype attributes?
3. Confirm the head-noun-as-primary-key design (§2.1, §4) over `domain`-scoped taxonomies, given the real domain list's fragmentation.
4. Confirm bug #4 (Tuk Shop L-dimension / `primaryDimension` axis identification) stays explicitly out of this ADR's scope, tracked separately against the dimension-vector mechanism.
