# Codex Review Response — PLAN v15.4–v15.7 Pad A

Datum: 2026-04-30
Reviewer: Codex (advisory-only post-Opus)
Plan-versie gereviewed: v1
Resultaat: **Approval — plan kan door naar `/ship v15.4`**, met 5 hardening-aanscherpingen die in plan v2 zijn verwerkt.

---

## Codex' antwoord (verbatim)

> Plan-richting akkoord: Pad A eerst is correct. v15.4-v15.7 lost de echte funderingsproblemen in de juiste volgorde op: variance-control → CLV-truth → drift/demotion → phase/unit governance.
>
> Mijn belangrijkste inhoudelijke aanscherpingen:
>
> 1. v15.5 is de echte blocker-slice. Zolang CLV-match-rate niet betrouwbaar ≥80% is, mag v15.6 drift-detectie niet shippen behalve in shadow/read-only mode.
>
> 2. v15.4 variance-gate moet niet alleen odd >3.0 cappen, maar telemetrie per odds-bucket loggen: n, ROI, avg CLV, positive CLV rate. Anders zijn +1pp/+2pp MIN_EP educated guesses zonder feedback.
>
> 3. v15.6 demote moet anti-yo-yo krijgen: demote pas bij voldoende sample, bv. n≥30 over 21d of n≥10/week × 3 weken, en re-promote pas na 28d cooldown + positieve CLV over nieuwe sample.
>
> 4. v15.7 auto-unit-change moet operator-confirm of minimaal "effective next scan/day" hebben. Geen stille unit-sprongen midden op een dag.
>
> 5. Pad B carve-out mag alleen passief/administratief zijn: account klaarzetten of paid-tier prijzen checken is oké; geen code voor harvest/camouflage vóór Pad A exit-criteria.
>
> Approval: Plan kan door naar v15.4, met v15.5 als harde gate vóór v15.6/v15.7.

---

## Verwerking in plan v2

| # | Codex finding | Verwerkt in | Hoe |
|---|---|---|---|
| 1 | v15.5 als harde gate, v15.6 alleen shadow als CLV<80% | §5.3 (v15.6 Vereist + Scope) | "Bij niet-gehaald: v15.6 ship in shadow/read-only mode" + handmatig activate-endpoint + telemetrie `driftDetector.mode` |
| 2 | Per-odds-bucket telemetrie in v15.4 | §5.1 (v15.4 Scope + Files + Telemetrie) | `bets.odds_bucket` kolom + `scripts/odds-bucket-audit.js` + scan-log split low/mid/high |
| 3 | Anti-yo-yo formule concreter | §5.3 (v15.6 Scope) | "n≥30 over 21d OF n≥10/week × 3w" + "28d cooldown + positieve CLV op nieuwe sample" + severity-formule (CLV ≤-2% → shadow, anders halveren) |
| 4 | Auto-unit-change pre-announce | §5.4 (v15.7 Scope + Tests) | "Effective vanaf eerstvolgende 00:00 ná ≥24u" + `unit_change_pending` notificatie + cancel-pending endpoint + anti-flap-yo-yo (geen 2x richtingswissel binnen 14d) |
| 5 | Pad B carve-out clarification | §8 (Niet-doen-lijst) | Toegevoegd "Pad B carve-out — wel toegestaan" sectie: research/admin OK, code niet OK |

Test-tellers per slice opgehoogd om de nieuwe scope te dekken (v15.4: 10→12, v15.6: 20→22, v15.7: 25→28).

## Geen veto, geen P0/P1

Alle 5 findings zijn P1 (1) of P2 (2,3,4) of P4 (5) hardening-werk. Geen
correctness-bug of security-exploit gevonden. Plan kan door zoals Codex
expliciet stempelt.

## Volgende stap

Bart triggert `/ship v15.4 — variance-bom-gate + operator-inbox + coverage-audit-log + per-odds-bucket-telemetrie` (scope-naam uitgebreid om Codex finding #2 zichtbaar te maken).
