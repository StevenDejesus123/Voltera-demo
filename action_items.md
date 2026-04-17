# Action Items — Phase 3.2/3.4 Completion

> Source: Pete's Cosmetic Notes (Apr 10, 2026), Transcripts 09-11, commit history
> Owners: Prince (P), Steven (S)
> Status: [ ] Not started, [~] In progress, [x] Done

---

## Questions for Pete (Slack/Call)

**Q1. Customer segment hiding scope (ref 1.4)**
Pete asked to remove 13 segments from Market Intelligence filter toggles. Do sites belonging to those segments also disappear from the map by default? Or do they still show as pins — user just can't filter by those segments?
> Our recommendation: Hide the toggles only. Sites still appear. Keeps the map data complete.

**Q2. Rideshare frequency (ref 1.7)** — RESOLVED
Checked raw NIQ Excel. Data is **annual**. Confirmed by cross-referencing LA MSA (~37.5M rides/yr) and CA state (~85.5M rides/yr) against known Uber+Lyft volumes. Label updated to "# of Rideshare Rides per Year".

**Q3. McKinsey Robotaxi data (ref 1.14)**
Blocked until Pete provides the dataset. No action needed from us until received.

**Q4. Jeff's voltage filter feedback (ref 2.4)**
Pete planned to show Jeff the tool. May result in a request for utility-specific voltage thresholds. Waiting on that review.

**Q5. Customer count accuracy (ref 1.18)**
LA MSA shows 9 customers — Pete thought this was high. We'll investigate the SF query and report back. Does Pete want this resolved before the demo, or is it informational?

---

## Epic 1: Cosmetic UI Changes (Capital Partners Demo)

### 1.1 Rename app title to "Catalyst"
- **Owner:** S
- **Status:** [x]
- **What:** Change "Site Ranking Explorer" to "Catalyst"
- **Where:**
  - `src/ui/src/components/MapExplorer.tsx:694` — main header h1
  - `src/ui/src/components/LandingPage.tsx:15` — landing page h1
- **Effort:** XS

### 1.2 Remove "Simulation Analysis" tab
- **Owner:** S
- **Status:** [x]
- **What:** Remove the disabled "Simulation Analysis" button from the header. Currently at `MapExplorer.tsx:954-965` with a "Coming Soon" badge. Also remove the `WhatIfPanel` conditional render at line 1132-1138 and its import.
- **Note:** Keep the `WhatIfPanel.tsx` component file — just disconnect it from the header. We may bring it back post-demo.
- **Effort:** XS

### 1.3 Remove "Compare" tab
- **Owner:** S
- **Status:** [x]
- **What:** Remove the disabled "Compare" button at `MapExplorer.tsx:966-982` with its "Soon" badge. Remove the `ComparePanel` conditional render at lines 1140-1152. Set all `onAddToCompare` props to `undefined` (some already are). Remove the import.
- **Note:** Keep `ComparePanel.tsx` file for future use.
- **Effort:** S

### 1.4 Remove customer segments from Market Intelligence
- **Owner:** P
- **Status:** [x]
- **What:** Pre-exclude 13 segments from default filter (toggles remain, pins hidden on load). Pete clarified: "I just want the standard filter settings to have those categories removed so that I don't need to go through and manually select them each time."
  - 3rd Party-Owned School
  - Automotive
  - Campus
  - Charging
  - Drayage
  - Heavy Duty Goods
  - Heavy Duty Networks
  - Heavy Duty People
  - Last Mile
  - Light Duty Goods
  - Light Duty Networks
  - Transit
  - Utilities
- **Where:** `CompetitorTrackerPanel.tsx:160` — `getCompetitorSegments()` returns all segments dynamically from the data. Add a `HIDDEN_SEGMENTS` set and filter them out in the `useMemo`.
- **Impact:** Only hides from the filter toggles. Does NOT remove the underlying site data — sites with these segments still appear on the map unless user filters by segment.
- **Decision needed:** Should sites with these segments also be hidden from the map by default, or just the filter toggles?
- **Effort:** S

### 1.5 Reorder RE stages in Market Intelligence
- **Owner:** S
- **Status:** [x]
- **What:** Change `STAGE_ORDER` array at `CompetitorTrackerPanel.tsx:45-54`.
- **Current order:**
  1. Market Search
  2. Short List
  3. LOI Negotiation
  4. PSA/Lease Negotiation
  5. Inspection Period
  6. Unsolicited Offer Sent
  7. Off Market Target
  8. Closed Won
- **New order (per Pete):**
  1. Market Search
  2. Short List
  3. Off Market Target
  4. Unsolicited Offer Sent
  5. LOI Negotiation
  6. PSA/Lease Negotiation
  7. Inspection Period
  8. Closed Won
- **Effort:** XS

### 1.6 Reorder Region Analysis sections
- **Owner:** P
- **Status:** [x]
- **What:** Change the render order of `CollapsibleSection` blocks inside `DetailSections` at `ExplainabilityPanel.tsx:180-473`.
- **Current order (all levels):** Infrastructure > Demographics > Mobility & Rideshare > Funding & Incentives > Costs > Grid Infrastructure > Climate & Risk
- **New order per Pete's doc:**
  - **MSA:** Mobility & Rideshare > Infrastructure > Climate & Risks (with Storm Risk added) > Demographics > Funding & Incentives > Costs
  - **County:** Mobility & Rideshare > Infrastructure > Demographics > Funding & Incentives > Costs
  - **Tract:** Mobility & Rideshare > Infrastructure > Demographics > Funding & Incentives > Costs > Grid Infrastructure
- **Implementation:** Refactor `DetailSections` to conditionally render sections in level-specific order. Could use an ordered array of section keys per geoLevel and map over it.
- **Effort:** M

### 1.7 Rideshare Trips — divide by 2 and relabel
- **Owner:** P
- **Status:** [x]
- **What:** The raw NIQ data counts roundtrips (origin + destination). Pete wants the displayed value halved to represent actual rides. Also relabel with the measurement time period.
- **Where (UI-level division):**
  - `ExplainabilityPanel.tsx:223-224` — change `details.rideshareTrips` to `Math.round(details.rideshareTrips / 2)` in the value prop
  - Same for `ridesharePerCapita` (line 227) and `rideshareDensity` (line 230) if applicable
  - Change label from `"Rideshare Trips"` to `"# of Rideshare Rides per [time period]"`
- **Open item:** Frequency (daily/weekly/monthly/annual) is NOT documented in the codebase. The raw data comes from `Integration_NIQ.xlsx` with column "# trips". Need to:
  1. Open the actual NIQ Excel file and check sheet metadata, headers, or any notes indicating the time period
  2. If not found in the file, ask Pete or check NIQ documentation
  3. Once confirmed, update the label. If unknown before demo, use "# of Rideshare Rides" without time qualifier and add a tooltip "Source: NielsenIQ"
- **Effort:** S

### 1.8 Remove rideshare density decimals at Tract level
- **Owner:** P
- **Status:** [x]
- **What:** Pete's doc says "No decimals for rideshare density" at Tract level.
- **Where:** `ExplainabilityPanel.tsx:230` — change `formatNumber(details.rideshareDensity)` to `formatNumber(Math.round(details.rideshareDensity))` or use a 0-decimal formatter.
- **Effort:** XS

### 1.9 Rename "AV Testing Sites" to "AV Testing ODDs" and move to Mobility
- **Owner:** P
- **Status:** [x]
- **What:** "ODD" = Operational Design Domain (standard AV industry term). Pete wants this field moved from the Infrastructure section into the Mobility & Rideshare section.
- **Where:**
  - `ExplainabilityPanel.tsx:194-196` — move this `DetailItem` block from inside the Infrastructure `CollapsibleSection` (lines 183-200) to inside the Mobility `CollapsibleSection` (lines 222-232)
  - Change the label string from `"AV Testing Sites"` to `"AV Testing ODDs"`
- **Effort:** S

### 1.10 Remove "AV Testing Vehicles" at County level
- **Owner:** P
- **Status:** [x]
- **What:** Pete says remove this line at County and Tract. Currently only visible at County per `FIELD_VISIBILITY`.
- **Where:** `analysisUtils.ts:75` — change `avTestingVehicles: { MSA: false, County: true, Tract: false }` to `{ MSA: false, County: false, Tract: false }`
- **Effort:** XS

### 1.11 Remove "Public Transit %" from Demographics
- **Owner:** P
- **Status:** [x]
- **What:** Remove at all levels.
- **Where:** `analysisUtils.ts:80` — change `publicTransitPct: { MSA: true, County: true, Tract: true }` to `{ MSA: false, County: false, Tract: false }`
- **Effort:** XS

### 1.12 Add "Storm Risk" at MSA level
- **Owner:** P
- **Status:** [x]
- **What:** Pete wants Storm Risk visible in the MSA-level Climate section.
- **Current state:**
  - Raw data EXISTS at MSA level: `MSA_ISTM_#` column in `Integration_National_Risk.xlsx` MSA sheet
  - ETL processes it: `external_data_msa.py:999` maps `MSA_ISTM_#` → `ISTM_RISKR_#`
  - BUT the export rankings field mapping for MSA (`export_rankings.py:535-551`) does NOT include `ISTM_RISKR_#` — only `HRCN_RISKR_#` (hurricane) is exported
  - UI visibility: `{ MSA: false, County: true, Tract: false }` at `analysisUtils.ts:92`
- **Changes needed:**
  1. `export_rankings.py` — add `("ISTM_RISKR_#", "stormRisk", "Storm Risk Rating")` to the MSA field mapping list (after line 548)
  2. `analysisUtils.ts:92` — change to `{ MSA: true, County: true, Tract: false }`
  3. Re-run the Python export pipeline to regenerate `regionDetails_msa.json` with stormRisk included
- **Note:** Since Pete also wants Climate removed at County/Tract (1.13), stormRisk will effectively only show at MSA.
- **Effort:** S

### 1.13 Remove Climate & Risks section at County and Tract
- **Owner:** P
- **Status:** [x]
- **What:** Pete's doc explicitly says "*Remove* Climate & Risks" for County and Tract. Keep at MSA level only.
- **Where:** Two approaches:
  - **Option A (visibility config):** Set all climate fields to `false` for County/Tract in `analysisUtils.ts`:
    - `snowdays: { MSA: true, County: false, Tract: false }`
    - `temperature: { MSA: true, County: false, Tract: false }`
    - `precipitation: { MSA: true, County: false, Tract: false }`
    - `hurricaneRisk: { MSA: true, County: false, Tract: false }`
    - `stormRisk: { MSA: true, County: false, Tract: false }`
    - `earthquakeRisk: { MSA: false, County: false, Tract: false }`
  - **Option B (component level):** Add `geoLevel === 'MSA'` guard on the Climate `CollapsibleSection` in ExplainabilityPanel.tsx
- **Recommended:** Option A (config-driven, consistent with how other fields work)
- **Effort:** S

### 1.14 Add "McKinsey Estimated # of Robotaxis by 2033" at MSA only
- **Owner:** P
- **Status:** [ ] BLOCKED — waiting on data from Pete
- **What:** New field in Mobility & Rideshare section, MSA level only. Pete says "I will be able to provide this data."
- **When unblocked:**
  1. Add field to `RegionDetails` interface in `types/index.ts`
  2. Add to `FIELD_VISIBILITY` in `analysisUtils.ts` (MSA: true, County: false, Tract: false)
  3. Add `DetailItem` in ExplainabilityPanel Mobility section
  4. Add field mapping in `export_rankings.py` MSA section
  5. Ingest the data — either as a new column in an existing Excel, or a new lookup file
  6. Re-run export pipeline
- **Effort:** M (once data arrives)

### 1.15 Remove "Outside Customer Interest Zone" badge
- **Owner:** P
- **Status:** [x]
- **What:** Remove the entire geofence status badge from the region analysis panel.
- **Context for Prince:** This badge shows at `ExplainabilityPanel.tsx:818-839` (single-region) and lines 704-725 (multi-region). It's driven by the `inGeofence` boolean on each Region, which comes from the geofence KML/KMZ overlay processing. When a tract/county/MSA overlaps with a customer geofence polygon, it's "Inside"; otherwise "Outside."
  - Pete's exact words: *"What does 'outside customer interest zone mean' we might want to remove this."*
  - Pete likely doesn't remember what drives this flag, and showing "Outside Customer Interest Zone" on most tracts adds noise for a demo audience who won't have context on what the "zone" means. The "Inside" state is arguably useful (highlights priority areas), but the "Outside" state adds no value.
- **Decision (Prince chose option B — remove entire section):**
  Remove both the single-region block (lines 818-839) and multi-region block (lines 704-725). Keep the `inGeofence` data in exports and map tooltips — just remove it from the region analysis panel.
- **Effort:** S

### 1.16 Remove Grid Assessment (costs + recommendation)
- **Owner:** P
- **Status:** [x]
- **What:** Pete says: *"I want to remove any costs that AI might be generating in the Grid Assessment. Hide recommendation section. Information like 'xx distance to nearest substation' and 'KV sub-transmission' and 'xx utility territory' is good."*
- **Decision (Prince chose option B — remove entire Grid Assessment subsection):**
  Remove the entire Grid Assessment block at `ExplainabilityPanel.tsx:407-448`. This block calls `generateGridInsight()` from `gridInsight.ts` and renders:
  - Headline ("Strong grid access — ready for EV deployment")
  - Capacity insight (includes cost estimates like "$50K-$150K")
  - Access insight (includes cost estimates)
  - Voltage insight
  - Territory insight
  - Recommendation section ("High-priority site. Initiate Preliminary Design Study...")
  All the raw data fields above line 407 (utility names, substation list, territory, readiness score, capacities, voltages, distances) remain untouched — Pete confirmed those are valuable.
- **Effort:** S

### 1.17 Sort Top Contributing Factors (High > Medium > Low)
- **Owner:** P
- **Status:** [x]
- **What:** Currently rendered in source array order. Pete wants them sorted by impact level.
- **Where:** `ExplainabilityPanel.tsx:887-898` — after the `filter()` on line 887, add a `.sort()`:
  ```ts
  const IMPACT_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const visibleFactors = singleRegion.factors
    .filter(f => !f.name?.toLowerCase().includes('land value'))
    .sort((a, b) => (IMPACT_ORDER[a.impact] ?? 3) - (IMPACT_ORDER[b.impact] ?? 3));
  ```
- **Effort:** XS

### 1.18 Filter MSA customer count — DONE
- **Owner:** P
- **Status:** [x]
- **What:** Pete clarified: *"anything that has 'Thesis' in the account should be filtered out. I only want counts for accounts segmented as AV-Ridehail or Non-AV Ridehail."*
- **Root cause:** LA showed 11 accounts including 2 Thesis placeholders + 3 non-AV accounts (LAUSD, Netflix, SCAQMD).
- **Fix:** In `export_salesforce.py` `_build_msa_summaries()`: skip accounts containing "thesis" (case-insensitive), only count accounts where `Customer_Segment__c` is "Autonomous Vehicles" or "Ride Hail (Non-AV)".
- **Note:** Requires re-running the SF export (`python -c "from src.exports.export_salesforce import run_export; run_export()"`) to regenerate `salesforceData.json` with updated counts.
- **Effort:** S

---

## Epic 2: Utility Grid Enhancements

### 2.1 Fix distribution line rendering with capacity filters
- **Owner:** S
- **Status:** [ ]
- **What:** From transcript 10 (Pete walkthrough): when user filters circuits by min load (e.g., 4 MW), the filtered tracts highlight correctly but the actual distribution line geometry does NOT render when clicking the tract. Pete expects to see the circuit lines on the map for tracts that match the filter.
- **Root cause investigation:** Check whether the circuit geometry query is correctly scoped to the filter values, or if it's using a different threshold than the panel filter.
- **Effort:** M

### 2.2 Expand utility grid geographic radius
- **Owner:** S
- **Status:** [ ]
- **What:** Currently ~10 km radius for circuit/substation display around a selected tract. Pete wants ~20 km ("twice as big") to see nearby infrastructure beyond the immediate tract.
- **Constraint:** Must not degrade load performance. Pete specifically said: "I don't want it to hinder... I don't want it to delay."
- **Where:** Find the distance threshold in the utility data query/render logic.
- **Effort:** S

### 2.3 Include utility grid data in exports
- **Owner:** P
- **Status:** [ ]
- **What:** Export filtered substations and circuits in KML/GeoJSON/Shapefile exports for use in LandVision and ArcGIS. Pete's core workflow: filter → export → upload to LandVision → find parcels near infrastructure.
- **Where:** `exportUtils.ts` — add circuit polylines and substation points as additional layers/folders
- **Constraints:**
  - LandVision: polygon/polyline only, no raw points, 30 MB max, 10-char DBF fields
  - Substations need 50m buffer circles (same pattern as site pins shapefile)
  - Export should respect active filters (min load, min capacity, voltage class)
- **From transcript 11 (Pete):** *"I would just want to pull. Hey, we filtered it down to this. This is what we would want to have."*
- **Effort:** L

### 2.4 Utility-specific voltage filter (pending Jeff feedback)
- **Owner:** S
- **Status:** [ ] BLOCKED — waiting on Jeff's review
- **What:** One utility in LA has an unusual voltage class. Pete may need a utility-specific voltage filter after his electrical engineer (Jeff) reviews the tool.
- **From transcript 11:** *"I might need to ask you to create another filter for just one of the utilities."*
- **Effort:** M (when unblocked)

---

## Epic 3: Backend Infrastructure

### 3.1 Utility data override backend
- **Owner:** S
- **Status:** [ ] BLOCKED — depends on CI/CD infrastructure
- **What:** Allow users to override read-only substation/circuit data (e.g., "source says 0 MW, we know it's 1 MW"). The override form UI exists in the frontend but is non-functional — needs a persistent backend.
- **From transcript 10 (Steven):** *"That's not working yet... we need the back end parts... infrastructure setup is needed for that."*
- **From transcript 11 (Pete):** *"I want to be able to show that feature [to Capital Partners], because I think that's a very unique value add."*
- **Scope:** Both substations AND distribution lines (Pete confirmed both)
- **Depends on:** CI/CD SOW completion (Subathra's team)
- **Effort:** L

---

## Epic 4: Additional Utility Data Sources

### 4.1 SDG&E — DONE
- **Status:** [x] Complete (commit `fd3618a`)

### 4.2 Remaining utility integrations
- **Owner:** S (ETL) + P (validation)
- **Status:** [~] In progress

| Utility | State | Status | Notes |
|---------|-------|--------|-------|
| SCE | CA | [x] Done | |
| PG&E | CA | [x] Done | |
| LADWP | CA | [x] Done | |
| SDG&E | CA | [x] Done | commit fd3618a |
| Georgia Power | GA | [~] Researched | No export UI; DevTools workaround documented |
| Pepco | DC/MD | [ ] Ready | ArcGIS REST endpoint confirmed |
| BGE | MD | [ ] Ready | ArcGIS REST endpoint confirmed |
| ComEd | IL | [ ] Ready | ArcGIS REST endpoint confirmed |
| National Grid | MA | [ ] Ready | ArcGIS REST endpoint confirmed (partial) |
| Dominion Energy | VA | [ ] Needs discovery | No public endpoint found yet |
| Eversource/NSTAR | CT/MA | [ ] Needs discovery | |
| CenterPoint | TX | [ ] Blocked | No public hosting |
| Tampa Electric | FL | [ ] Blocked | No public hosting |

- **From transcript 09 (Pete):** *"If you run into items where it's a massive lift... please let me know, because I want to be efficient with your all's time."*
- **Prioritization:** Follow the LandVision utility list Pete shared. If a utility requires >2 days of effort, flag to Pete for priority call.

---

## Open Items / Decisions Needed

### O1. Customer segment hiding scope (ref 1.4)
**Question:** Pete asked to remove 13 segments from the Market Intelligence filter toggles. Should sites belonging to those segments also be hidden from the map by default? Or do they still show as pins — the user just can't filter by those specific segments?
**Recommendation:** Hide the filter toggles only. Sites still appear. Keeps the map complete without confusing filter options.

### O2. NIQ rideshare frequency (ref 1.7)
**Status:** Not found in codebase or docs. Need to check `data/inputs/external/Integration_NIQ.xlsx` sheet headers or metadata. If no frequency is documented in the file, ask Pete or escalate to NielsenIQ contact.
**Fallback for demo:** Use label "# of Rideshare Rides" without time qualifier. Add "(Source: NielsenIQ)" as subtitle text.

### O3. McKinsey Robotaxi data (ref 1.14)
**Status:** Blocked on Pete providing the dataset. No action needed until received.

### O4. Jeff's voltage filter feedback (ref 2.4)
**Status:** Pete planned to show Jeff the tool and get feedback. May surface a request for utility-specific voltage thresholds.

### O5. Customer count accuracy (ref 1.18)
**Status:** Needs investigation. Low priority relative to cosmetic changes but should be understood before capital partners demo.

---

## Questions for Pete

> Copy-paste these into Slack or use as talking points on the next call.

---

**1. Customer Segments in Market Intelligence (ref 1.4)**

Pete, you asked us to remove these 13 customer segments from the Market Intelligence filter panel:
3rd Party-Owned School, Automotive, Campus, Charging, Drayage, Heavy Duty Goods, Heavy Duty Networks, Heavy Duty People, Last Mile, Light Duty Goods, Light Duty Networks, Transit, Utilities

Quick question — when you say "remove," which of these do you prefer?

**Option A — Hide the filter toggles only (our recommendation)**
- The 13 segment buttons disappear from the Market Intelligence panel
- Site pins for those segments still appear on the map as colored dots (green/red/blue based on category)
- Nobody seeing the demo would know a pin's segment unless they click it and read the detail card
- All underlying data stays intact — nothing is lost

**Option B — Hide the toggles AND remove the site pins from the map**
- The 13 segment buttons disappear from the panel
- Any site pin tagged with one of those 13 segments is also hidden from the map entirely
- Fewer pins on the map, but we'd be suppressing real site data
- Risk: if you or your team later wonders "where did that site go?" it could cause confusion

We recommend Option A — the filter toggles are what would trigger questions during a demo, not the pins themselves. The pins are just dots without visible segment labels. Let us know which way you'd like to go and we'll ship it same day.

---

**2. Rideshare Trips — time period (ref 1.7)** ✅ RESOLVED

We checked the raw `Integration_NIQ.xlsx` file. The data is **annual**. Cross-referenced the magnitudes against known public rideshare volumes:
- LA MSA: ~75M roundtrips → ~37.5M rides/year (matches Uber+Lyft combined annual for LA metro)
- California: ~171M roundtrips → ~85.5M rides/year (matches known ~60-80M/yr + other providers)

Label updated to "# of Rideshare Rides per Year". No action needed from you on this one.

---

**3. McKinsey Robotaxi Data (ref 1.14)**

You mentioned you'd provide the "McKinsey Estimated # of Robotaxis by 2033" data for the MSA-level Mobility section. Whenever you have that dataset ready, send it our way and we'll integrate it. No rush — the UI slot is ready for it.

---

**4. Jeff's Utility Grid Feedback (ref 2.4)**

After Jeff reviews the utility grid tool, let us know if he wants any changes to the voltage filters or circuit classification. You mentioned one LA utility has an unusual voltage — once Jeff confirms what he needs, Steven can add a utility-specific filter.

---

**5. Customer Count in LA (ref 1.18)**

You flagged that LA MSA showing 9 customers seemed high. We dug into it — the count actually shows 11 now (may have grown since you checked). It comes from Salesforce Sales Opportunities — unique `Account.Name` values per MSA. Here's the full breakdown for LA:

| # | Account Name | Notes |
|---|---|---|
| 1 | Cruise | Real customer |
| 2 | Einride | Real customer |
| 3 | Greenlane | Real customer |
| 4 | **Los Angeles Unified School District** | One-off prospect? Not a core EV/AV customer |
| 5 | **Netflix** | Unusual — not a typical EV charging customer |
| 6 | **South Coast Air Quality Management District Building Corp** | Government entity |
| 7 | Tesla | Real customer |
| 8 | **Thesis Place Holder - Class 1-3 (AV/Rideshare/Rental)** | SF placeholder, not a real account |
| 9 | **Thesis Place Holder - D&D (drayage)** | SF placeholder, not a real account |
| 10 | Waymo | Real customer |
| 11 | Zoox | Real customer |

The "Thesis Place Holder" entries appear across 6 MSAs — they inflate the count everywhere. Those are clearly not real customers and we can filter them out on our end immediately.

The other three (LAUSD, Netflix, Air Quality District) are real Salesforce records but seem like non-core accounts. Up to you whether those should count.

**What we recommend:**
- We'll filter out the "Thesis Place Holder" accounts right away (drops LA from 11 → 9)
- Let us know if you also want LAUSD, Netflix, and the Air Quality District excluded — or if those are legitimate pipeline accounts we should keep
