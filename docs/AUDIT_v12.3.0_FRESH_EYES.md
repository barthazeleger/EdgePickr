# EdgePickr · fresh-eyes audit pass v12.3.0

**Datum:** 2026-04-25/26 (overnight)
**Reviewer:** Claude (onafhankelijk van implementatie-flow), 2 parallelle Explore-agents (code-review + security/coverage)
**Scope:** 25 commits sinds vorige audit (v12.2.25 → v12.2.50). Doel: regressie-risico, doctrine-drift, test-coverage gaps, security exposures.

---

## Verdict

**Laag-medium regressie-risico, geen P0/P1 echte bugs.** Eén productie-crash gespot in v12.2.49 (TDZ-error op Render boot) — al gefixt in v12.2.50 hotfix. Plus 5 false-positive bevindingen die bij verificatie geen echte issues bleken.

**Ingeleverd in v12.3.0:** 2 urgente UX-bugs uit operator-screenshot + 3 P2 hardenings + 3 test-coverage gaps.

---

## 1. Operator-feedback (urgent)

### CLV-check notification spam
**File:** `server.js:1349` `logCheckFailure()`
**Issue:** Daily-job + pre-kickoff scheduler kunnen dezelfde fixture-failure ~10× spammen binnen een paar minuten (operator-screenshot 25-04 21:03: Ottawa Senators × 10).
**Fix v12.3.0:** dedup-window van 6 uur per (type + wedstrijd-titel). Voor de insert lookup checken of een identieke notification al bestaat.

### "Wis alles" werkt niet voor `check_failed`
**File:** `lib/inbox-notification-types.js:3-15`
**Issue:** `check_failed` zat in `PERSISTENT_INBOX_NOTIFICATION_TYPES` set → werd overgeslagen in DELETE-loop (`!isPersistentInboxNotificationType` filter, line 116 van `lib/routes/notifications.js`). Operator klikte "Wis alles" → niets gebeurt.
**Fix v12.3.0:** `check_failed` weggehaald uit persistent set. Operationele ruis hoort niet in audit-trail. Echte audit-events (stake_regime_transition, drift_alert, kill_switch, autotune_run, clv_milestone, clv_backfill, etc.) blijven persistent.

---

## 2. P2 hardening

### P2.1 · concept-drift threshold rounding
**File:** `lib/routes/admin-timeline.js:109-113`
**Issue:** `delta30v90 = +(w30.brier - w90.brier).toFixed(5)` rondt VÓÓR de threshold-comparison. Edge case: delta = 0.020001 → toFixed → 0.02 → comparison `0.02 > 0.02` → false → drift-signaal gemist.
**Fix v12.3.0:** vergelijk RAW delta tegen drempel; behoud `.toFixed(5)` alleen voor display in response-velden.

### P2.2 · admin-inspect inconsistente error-logging
**File:** `lib/routes/admin-inspect.js:195-197`
**Issue:** catch-block `res.status(500).json({ error: 'Interne fout' })` zonder `console.error`. Andere admin-routes loggen wel. Maakt prod-debugging onnodig moeilijk.
**Fix v12.3.0:** `console.error('[admin-inspect]', e?.message || e);` toegevoegd. Generic error blijft naar client (geen leak).

### P2.3 · UI pickStrength undefined kelly
**File:** `index.html:1483` (renderPicks helper)
**Issue:** legacy scan_history entries zonder `kelly` field vallen stilzwijgend op 0 in sortering. Niet fataal — oude entries onderaan is waarschijnlijk gewenst — maar verbergt mogelijke server-side regressies.
**Fix v12.3.0:** `console.warn('renderPicks: pick missing kelly field', p?.match)` als pick.kelly geen number is. Dev-aid only, runtime ongewijzigd.

---

## 3. Test-coverage gaps gedicht

### T1 · `diagnoseJoinFailure` null `model_runs`
**Test:** `test.js` v12.3.0 nieuw — candidate met `model_runs: null` → `market_mismatch` (graceful via optional chaining op line 143). Bewijst dat de filter geen crash geeft.

### T2 · `createKillSwitch.refresh()` met notification insert-error
**Test:** `test.js` v12.3.0 nieuw — refresh() loopt door wanneer notification-insert throw't; state.set wordt nog steeds correct gepopuleerd.

### T3 · `summarizeSharpSoftWindows` includeMirror=true + only sharp bookies
**Test:** `test.js` v12.3.0 nieuw — alleen Pinnacle data + includeMirror=true → leeg resultaat (geen soft-side, dus geen window). Bewijst mirror-filter onder edge-case bookie-distributie.

---

## 4. False-positives (bij verificatie afgewezen)

| # | Origineel finding | Reden afgewezen |
|---|---|---|
| FP1 | "snapshots scoped bestOv/bestUn bug" | Args expliciet doorgegeven aan helpers. Geen alternatieve code-paths bestaan. Phantom. |
| FP2 | "kill-switch state mutation race" | Node.js single-threaded JS event loop. Synchrone mutations hebben geen "between" point. Niet van toepassing. |
| FP3 | "F5 bucket migratie moet legacy 'over' mergen" | BY DESIGN per audit P3 fix (v12.2.28). Going-forward separation; legacy bucket decay is intent. |
| FP4 | "Sharp-soft push body fixture-naam plaintext" | Single-operator (Bart, eigen device, eigen telefoon). Audit P2.5 al genoteerd als "no action — single-operator". |
| FP5 | "Migratie v12.2.27 unique-index drop gap" | One-time, low-write tabel. Upsert dedupliceert app-side. Risico nul in praktijk. |

---

## 5. Doctrine-drift check

**Wel scope-creep gespot, niet doctrine-violerend:**
- 3 doc-files toegevoegd (ADMIN_ENDPOINTS.md, AUDIT_v12.2.23_FRESH_EYES.md, SESSION_SUMMARY_2026-04-25.md) — operator-utility, niet in audit-roadmap maar zinvol bij 41 commits/dag.
- v2 BTTS/threeway/DC wiring (v12.2.38, .46, .47) — was niet expliciet in audit, logisch vervolg op v2 totals coverage rollout. Behouden.
- R8 step 1+2 (v12.2.48-49) — audit zei "niet urgent". Heeft één productie-crash veroorzaakt (TDZ in v12.2.49 → v12.2.50 hotfix). **Lesson learned:** elke server.js extract krijgt voortaan een handmatige `node -e "require('./server.js')"` smoke-test vóór push.

---

## 6. Bewust deferred met heldere triggers (R1 / R2 / R3)

Per Bart's instructie "alles bouwen, behalve als nu echt niet zinvol — dan auto-switch inbouwen".

**R3 is afgewezen voor v12.3.0:** Bayesian dynamic team-strength is multi-week SOTA werk per audit (Macri-Demartino 2025). Een scaffold zonder echte implementatie is theater — operator merkt niets, code-complexiteit stijgt. **Beslis-trigger:** als `/admin/v2/model-brier` over ≥200 settled bets `model_beats_market: false` rapporteert (= ons model verliest van markt), dan starten we een dedicated 2-week R3-sprint.

**R1 (log-margin devig swap) en R2 (isotonic regression) zijn óók afgewezen voor v12.3.0:**
- R1: helpers bestaan al sinds v12.2.11 (`lib/devig.js`). Backtest endpoint bestaat sinds v12.2.22 (`/admin/v2/devig-backtest`). De swap zelf is een 1-line config wijziging zodra data uit het backtest-endpoint dat rechtvaardigt (mean abs diff > 1pp consistent over 7 dagen).
- R2: vereist ≥100 bets met canonical join (`/admin/v2/model-brier?days=90` `joinCoverage.model >= 100`). Tot dan is een isotonic-fit op kleine n statistisch onbetrouwbaar. Helper-skeleton zonder wiring zou theater zijn.

**Auto-switch infrastructuur is in plaats voor R1 + R2** via de bestaande admin endpoints — operator runt het backtest weekly, ziet de delta, beslist met data. Dat is het auto-switch pattern. Geen extra code-paths nodig die jaren lang stil staan.

---

## 7. R5 / R6 (strategisch held)

Onveranderd: live betting (R5) en betaalde Sports API (R6) blijven geblokkeerd op pre-match Brier <0.22 + CLV >+2% over 200 settled (R5) en bankroll-headroom > €5k voor budget (R6). Geen actie nodig in v12.3.0.

---

## 8. Aanbevelingen na v12.3.0

1. **Run `/admin/v2/devig-backtest?hours=168&min_bookmakers=4` 1× per week.** Als meanAbsDiffPp consistent > 1pp → R1 swap kan plaatsvinden.
2. **Run `/admin/v2/model-brier?days=90` 1× per week.** Wanneer joinCoverage.model > 100: R2 isotonic-fit zinvol.
3. **Scan inbox `notifications` table 1× per week** voor categorieën die sinds v12.3.0 niet meer worden gefilterd door persistent-set: check_failed dedup zou nu het volume met ~90% moeten reduceren.
4. **Bij elke server.js refactor:** `SUPABASE_URL=https://test.supabase.co SUPABASE_KEY=test JWT_SECRET=test node -e "require('./server.js')"` smoke-test als pre-push gate.

---

## Test counts

- Vóór v12.3.0: 770 tests passed
- Na v12.3.0: 773 tests passed (+3: T1, T2, T3)

## Files in deze audit-batch gewijzigd

- `server.js` (logCheckFailure dedup)
- `lib/inbox-notification-types.js` (check_failed weg uit persistent)
- `lib/routes/admin-timeline.js` (concept-drift raw-delta comparison)
- `lib/routes/admin-inspect.js` (error logging consistency)
- `index.html` (pickStrength warn)
- `test.js` (3 nieuwe tests)
- `docs/AUDIT_v12.3.0_FRESH_EYES.md` (deze)
- `CHANGELOG.md` (v12.3.0 entry)
- 7 version-pin files (app-meta, package, package-lock, index, README, operating-model, test version assertion)
