# Codex Review Request — PLAN v15.4–v15.7 Pad A

Datum: 2026-04-30
Plan: `docs/PLAN_v15.4-v15.7_PAD_A.md`
Auteur plan: Claude (Opus 4.7)
Reviewer: Codex (advisory-only post-Opus, geen veto)

---

## Context voor Codex

Bart en Claude hebben een grill-sessie gedaan over de fundamentele vraag:
**"Is huidige EdgePickr-architectuur de optimale methode om netto bankroll te
laten groeien?"**

Conclusie van de grill:

- ROI laatste 18d = +2% over 65 bets (statistisch =break-even)
- CLV-meting kapot (bookie/market matching faalt)
- Concept-drift detectie ontbreekt (BTTS-NO bleef gespeeld na degradatie)
- High-odds picks ongedempte variance-bommen
- v15.0.12-v15.3.1 werk (TSDB-uitbreiding, expansion-shadow) bouwde
  signal-expansion **vóór** de fundering — exact wat doctrine §6 verbiedt

Daarom: **Pad A (edge-bewijs) eerst, Pad B (sharp-book + camouflage + harvest)
later.** Pad A heeft 4 slices (v15.4-v15.7) en 4 exit-criteria.

Lees eerst `docs/PLAN_v15.4-v15.7_PAD_A.md` volledig. Dit document bevat
specifieke review-vragen per sectie.

## Review-format

Per finding:

```
[P-level] §<sectie> — <korte beschrijving>
Voorstel: <concreet alternatief of aanvulling>
```

P-levels (uit doctrine):

- **P0** = security exploit met concreet aanvalspad
- **P1** = correctness bug of data-corruptie risico in plan-logica
- **P2** = quality/hardening gap (defense-in-depth)
- **P3** = performance / efficiency
- **P4** = doctrine/strategisch — meningsverschil dat Bart moet beslissen

**Geen "waarschijnlijk oké"** — bewijs of het is een finding.

## Out-of-scope voor deze review

We willen **niet** dat Codex:

- Het hele Pad A vs B model omver gooit zonder concrete data-onderbouwing
- Nieuwe sport-uitbreiding voorstelt (geparkeerd tot Pad A done)
- Discussieert of grill-sessie's conclusies kloppen — die zijn akkoord
- Fundamentele model-wijzigingen voorstelt (Bayesian shrinkage redesign etc) —
  alleen als ze een Pad A exit-criterium direct beïnvloeden

We willen **wel** dat Codex:

- Sequencing tussen v15.4-v15.7 challenged op afhankelijkheden of timing
- Exit-criteria challenged op wel/niet streng/realistisch genoeg
- Per slice mogelijke bugs/edge-cases in de scope identificeert
- Operator-inbox spec challenged op operator-ergonomie
- Auto-promotion/demotion-mechaniek challenged op anti-flap, anti-yo-yo, anti-BTTS-bug-pattern

## Specifieke review-vragen

### A. Strategische beslissing (PLAN §2)

A.1 Is de **rode-vlag-trigger** (n≥200, ROI<0%, CLV<+0,5%) streng genoeg?
Of moet er ook een tijds-component in (bv. "binnen 6 maanden niet
bereikt = tijdelijke pauze + diagnose")?

A.2 Pad B wordt geparkeerd tot Pad A done — is er een **carve-out**
nodig voor low-effort Pad B-prep dat "voor niets" mee komt? Bv. Bet105
account aanmaken vooruit, OddsPapi-paid-tier evalueren als data al binnen
ligt? Of is dit scope creep?

### B. Exit-criteria (PLAN §3)

B.1 `clv_pct ≥ +1,5% met match_rate ≥ 80%` — is 80% match-rate haalbaar
binnen 4-6 maanden gegeven huidige bookie-naam-chaos? Of moeten we eerst
v15.5 deployen, dan een redelijke baseline-meting doen, dán de drempel
finaliseren?

B.2 Drift-criterium "geen signaal met ≥3w negatieve CLV-trend zonder
demote-trigger" — kan Codex de exacte demote-conditie scherper formuleren?
Wat als signaal n=3/week heeft (te dun), of CLV oscileert -0,1/+0,1 (geen
echte drift maar wel over drempel)?

### C. Bankroll & unit (PLAN §4)

C.1 Optie A (deposit nu) vs B (reserve mentaal) — is er een derde optie
die we missen? Bv. **gefaseerde stort** (€100 nu, €144 als BR ooit -10%
hit)?

C.2 Schaal-up regel "n≥500, ROI≥5%, +CLV stabiel 8w → €25-50 unit" — is
dit te conservatief gegeven Bart's tijdsdruk (kind 9 maanden), of juist
correct vanuit risk-of-ruin perspectief?

### D. Slice v15.4 — Variance-bom-gate (PLAN §5.1)

D.1 Per-odds-bucket MIN_EP-verhoging (1pp / 2pp). Is dit een educated
guess of empirisch? Heeft Codex data over CLV per odds-bucket op huidige
65-bet sample? Zo ja: zijn 1pp / 2pp de juiste drempels?

D.2 `max 0,5U cap voor odd > 3.0` — interageert dit goed met de
bestaande `kellyToUnits` mapping? Of moet de cap eerder, in HK-berekening
zelf?

D.3 Coverage-audit-log — pure read-only is veilig. Maar moet het
**actief** ligas markeren voor Codex/Bart-review als ze 90d 0 picks
hebben? Of laten we dat aan Bart over om te interpreteren?

### E. Slice v15.5 — CLV-meting overhaul (PLAN §5.2)

E.1 Bookie-naam-normalisatie — bestaat er al een aliassen-tabel ergens
in code? Zo nee: is een statische map (Bet365 = bet365 = Bet 365 =
bet365_uk) genoeg, of hebben we per-source dynamische resolution nodig?

E.2 Closing-line snapshot ±5min van kickoff — is dat haalbaar met
huidige scan-cadens (3 scans/dag) en de OddsPapi free-tier rate-limits?
Of vereist dit een dedicated closing-line-job buiten de scans om?

E.3 Wekelijkse Pad-A-progress-notificatie — ongeacht of v15.7
phase-controller af is, kunnen we al in v15.5 de **eerste versie** van
deze notificatie laten lopen op stub-evaluator? Of wachten tot v15.7?

### F. Slice v15.6 — Drift-detectie + auto-demote (PLAN §5.3)

F.1 Anti-flap-guard "niet promoten/demoten binnen 14d window" — is 14d
de juiste duur? BTTS-NO casus: degradeerde over weken, niet dagen. Maar
te lange guard = te trage reactie op echte drift.

F.2 Demote-actie "weight halveren OF naar shadow afhankelijk van
severity" — wat is severity-criterium? CLV-magnitude? n-size? Recency?
Codex: stel concrete formule voor.

F.3 League-level demote-mechaniek — interageert dit met `signal-weights`
hiërarchie (`sport:market:signal` → `sport:signal` → `signal`)? Komt er
een nieuwe laag bovenop of wordt het geïntegreerd?

### G. Slice v15.7 — Phase-controller + unit-controller (PLAN §5.4)

G.1 Auto-unit-change zonder operator-confirm — risico dat unit
plotseling springt op één gunstige week. Mitigation: minimum 4w stabiele
trend voor change. Codex: streng genoeg?

G.2 `unit-size-controller` integratie met bestaande `lib/stake-regime.js`
— moet stake-regime worden vervangen, of wordt unit-controller een laag
**erbovenop**? Risico van twee parallelle systemen.

G.3 Data-source ROI audit — hoe attribueer je een +CLV pick aan de
sources die hem voedden? Een pick gebruikt vaak 3-5 sources (api-sports
fixture, TSDB form, OddsPapi sharp anchor, etc). Is dit Shapley-style
attribution of grover (counterfactual: zou pick gemaakt zijn zonder
source X)?

### H. Operator-inbox (PLAN §6)

H.1 Webpush alleen voor `operator_action` en `red_flag` — mist Bart
relevante info? Bv. unit-change zonder push betekent dat hij dagen later
pas weet dat zijn unit gewijzigd is.

H.2 Categorie-set compleet? Of mist er iets (bv. `cost_alert` als
TSDB/api-sports quota dreigt te overschrijden)?

### I. Activation contract (PLAN §7)

I.1 Geen-deploy-windows 07:30/14:00/21:00 Amsterdam — is buffer ±15min
voldoende, of moet het ±30min zijn (sommige scans lopen lang)?

I.2 `/audit v15.X` na 7d soak — hoe definieert Bart "doelwaarden"
expliciet? Per slice in plan-doc, of in de CHANGELOG-entry zelf?

### J. Niet-doen-lijst (PLAN §8)

J.1 Tennis/rugby/cricket blijven shadow — maar leveren ze relevante
shadow-data op of zijn ze pure overhead? Voorstel evt: tennis pauzeren
volledig tot Pad A done?

J.2 "Geen nieuwe signal-types alleen bestaande tunen" — hard genoeg,
of is er een uitzondering voor signalen die direct uit v15.6 drift-werk
voortkomen (bv. een nieuw "stale-line" signaal als drift-detector
ontdekt dat dat de oorzaak van degradatie is)?

## Antwoord-deliverable

Codex levert één markdown-blob (`CODEX_REVIEW_RESPONSE_PAD_A.md` of
inline plak) met:

1. **Top-3 P0/P1 findings** (als die er zijn) bovenaan
2. **Per sectie A-J:** alle findings in P-level format
3. **Algemene observatie** indien nodig: missende sectie / sequencing /
   strategische bias die Codex ziet
4. **Approval/rejection-stempel:** "Plan kan zo door (met findings als
   parallel work)" OF "Plan moet eerst gerevised op X/Y/Z voor
   `/ship v15.4` mag"

Bart paste de blob terug aan Claude. Claude verwerkt findings in plan-
revisie (commit `[claude+codex] Pad A plan revision per Codex review`)
of in slice-implementatie (waar P-level dat toelaat).

---

**Bart: paste alles vanaf "## Context voor Codex" tot hier in Codex-chat.
Antwoord van Codex paste je terug aan Claude in deze repo.**
