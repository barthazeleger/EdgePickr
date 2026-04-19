# Brief aan Codex · 2026-04-19

**Branch**: `barthazeleger/sec-review-prs`
**Huidige HEAD**: `0c77596` (v11.3.28, op master)
**Reporter**: Bart (operator) — Claude (Opus 4.7) schrijft dit

## Samenvatting operator-rapport

Sinds **2026-04-18 09:33** (mogelijk eerder, kon niet verder terug in UI) produceren alle scans **alleen Over 2.5 goals voetbal picks**. Elke scan: 2 picks, altijd Over 2.5, altijd via Bet365. Bij alleen-Unibet preferred: 0 picks. Geen BTTS, geen 1X2, geen DNB, geen DC, geen basketball/hockey/baseball/NFL/handball picks. Patroon persist na v11.3.28 deploy (mijn hotfix om dit patroon op te lossen).

Bart's exacte woorden: *"er moet gewoon een bug in zitten. De laatste picks gaan ook helemaal niet zo goed de over 2.5 picks. Ga zoeken en kom met iets, wacht met pushen, schrijf een bericht aan codex met je bevindingen dan laat ik hem hetzelfde doen."*

## Tijdlijn van verdachte commits

| Tijd | Versie | Wijziging |
|---|---|---|
| 2026-04-18 09:30 | v11.1.2 | Added `passesDivergence2Way` sanity-gate op 11 markten (1X2, BTTS, DNB, Basketball ML, Baseball ML, NRFI, F5 ML, Run Line, Puck Line, NFL ML, Handball ML) — threshold 0.04 |
| 2026-04-18 09:52 | v11.2.1 | "P0 volledige sanity-coverage" — extended gates naar alle O/U + Odd/Even (11 sites) incl Hockey Team Totals (Poisson-based). Ook `ov.length && un.length` → `>= 2 && >= 2` op O/U markten buiten football 2.5 |
| 2026-04-18 22:00+ | v11.3.28 | Hotfix: threshold 0.04 → 0.07 + rollback van `>= 2` naar `&&`. **Heeft het probleem NIET opgelost** |

## Mijn diagnose (mogelijk onvolledig — daarom jouw second opinion)

De sanity-gate vergelijkt `model-prob` vs `market-devigged-prob`. Voor Over/Under is `overP` by construction **identiek** aan marketdevig (= `avgIP / totIP`) → gate passeert altijd. Voor **BTTS en Team-Totals** komt de model-prob uit een **onafhankelijke formule** (`calcBTTSProb`, Poisson λ), niet uit devigging. Die prob zit structureel 8-15pp van marketdevig af — want het meet iets anders (conditional scoring events vs implied market prob). Sandy gate faalt altijd op 7pp. Voor **1X2** geven cumulatieve signals 5-10pp push (referee + H2H + form + predictions + congestion + weather) → ~30-50% faalt nog op 7pp.

Alleen Over/Under 2.5 voetbal overleeft structureel. Bet365 komt als `best.bookie` omdat die de beste preferred-price geeft (Unibet heeft tightere prijzen op dezelfde lines).

**Conclusie**: de gate is architecturaal mis-toegepast op markten waar het model-principe verschilt van pure devig.

## Wat ik NIET zeker weet — vragen voor jou

1. Klopt mijn diagnose dat `calcBTTSProb` per definitie niet in dezelfde ballpark als marketdevig kan liggen? Of kunnen deze 2 op een diepere methodologische manier convergeren die ik mis?
2. Voor **1X2**: verhoogt `adjHome2` door cumulatieve signals echt 5-10pp van `fp.home` af, of overschat ik dit? Concrete reality-check op één voetbal-fixture in huidige code zou helpen.
3. Is er een **andere** bug die ik mis? De Explore-subagent suggereerde (samengevat):
   - Orchestrator race: `setPreferredBookies(null)` in finally vs Promise.all → ik heb deze gecontroleerd, **lijkt geen race** want finally draait pas na alle awaits klaar zijn. Maar dubbel-check graag.
   - Kill-switch bulk-block: geen evidence in git log, maar `_calibCache.markets[key].killed` kan via admin-endpoint gezet zijn. Kan niet via `grep` verifiëren zonder DB-access.
4. Is er een **signals-store** issue? `loadSignalWeights()` - laden signals wellicht als 0 voor alle behalve Over? Ik heb dit niet diep gecheckt.
5. `cm.over.multiplier = 1.09` (autotune-output): is dit een **sizing multiplier** (op kelly) zoals ik las, of ook op prob? Als ook op prob: verklaart Over-boost maar niet het absent-zijn van andere markets.

## Voorgestelde fix (Claude's voorstel)

**Optie A — Market-aware threshold differentiatie:**

```js
// lib/model-math.js
const SANITY_THRESHOLDS = {
  default: 0.07,             // market-devig basis (Over/Under, 1X2)
  model_based: 0.15,         // BTTS (calcBTTSProb), Team Totals (Poisson)
  signal_heavy: 0.10,        // 1X2 football (referee + H2H + form + ...)
};
```

Per callsite expliciet doorgeven:
- `passesDivergence2Way(overP, underP, ..., 0.07)` — O/U
- `passesDivergence2Way(bttsYesP, bttsNoP, ..., 0.15)` — BTTS
- `passesDivergence2Way(pOver, pUnder, ..., 0.15)` — Hockey Team Totals

Rationale: Sandefjord was 34pp, blokkeerd nog steeds. Legitieme BTTS-based picks (10pp van markt) krijgen lucht. 1X2 met zware signal-push (10pp) krijgt lucht.

**Optie B — Volledige rollback van v11.1.2 + v11.2.1 gates**, alleen een grove "extreme guard" behouden (>=20pp fail op alle 2-way markten). Sandefjord-class wordt dan nog wel gevangen. Minder precies maar elimineert architecturale mismatch.

**Optie C — Signal-quality-aware gate**: voor BTTS vereis `h2hN >= 5` (Sandefjord was n=2), voor 1X2 `bookieCount >= 4`. Dicht de dun-data oorzaak van Sandefjord af i.p.v. model-push breed te blokkeren.

Mijn voorkeur: **Optie A + Optie C**. Optie A geeft onmiddellijke verlichting, Optie C adresseert de echte Sandefjord-oorzaak.

## Wat ik wil dat jij doet

1. **Valideer de diagnose**. Als ik het fout heb: waar klopt de analyse niet?
2. **Suggest pinpoints**: specifieke file:line waar een bug zit die ik gemist heb.
3. **Beoordeel de fix-opties**. Welke vind je het meest verdedigbaar? Ik neig naar A+C.
4. **Geef een orde van implementatie** zodat Bart morgen 07:30 scan wel picks heeft uit meer dan alleen Over 2.5.

## Constraints voor jouw response

- Geen "waarschijnlijk oké" — bewijs of findings.
- `[P-level] file:line — bevinding + voorstel` formaat.
- P0 = concrete exploit/pipeline-brekende bug met repro.
- Als je wilt dat ik iets uitvoer voor je (grep/read), zeg dat expliciet + de exacte command — ik heb tool access, jij niet.

Bart leest dit en gaat er zelf mee aan de slag parallel aan jou. Als onze analyses convergeren → fix. Als ze divergeren → open vraag voor Bart.

— Claude (Opus 4.7) voor Bart
