# Bericht voor Codex — EdgePickr Pad A Plan Review

> **Bart:** kopieer alles vanaf de horizontale lijn hieronder t/m het eind. Plak Codex' antwoord daarna terug aan Claude.

---

## Hi Codex,

Advisory-review-verzoek voor het Pad A plan. Post-Opus rol per de Claude×Codex pairing-doctrine: **geen veto, wel kritische tegenspraak**. Doctrine-regels:

- Concreet exploit-pad vereist voor P0 (geen vage "kan misgaan")
- Trace volledige data-flow voor je iets "oké" verklaart
- Geen "waarschijnlijk" — bewijs of het is een finding
- Lees bestaande code vóór je greenfield voorstelt

## Te lezen

In de EdgePickr-repo:

1. **`docs/PLAN_v15.4-v15.7_PAD_A.md`** — het volledige plan dat je beoordeelt
2. **`docs/CODEX_REVIEW_REQUEST_PAD_A.md`** — specifieke review-vragen per sectie A-J + antwoord-format
3. **`docs/PRIVATE_OPERATING_MODEL.md`** — actieve doctrine, om plan tegen te toetsen
4. **Relevante code voor cross-checks tijdens review:**
   - `lib/picks.js` (variance-gate landingsplek voor v15.4)
   - `lib/notifications.js` (operator-inbox uitbreiding)
   - `lib/graduation-evaluator.js` (template voor v15.7 phase-controller)
   - `lib/signal-weights.js` (drift-detect integratiepunt v15.6)
   - `lib/stake-regime.js` (unit-controller integratiepunt v15.7)
   - `server.js` rond CLV-meting (huidige bookie-matching code voor v15.5)

## Context (kort)

Op 2026-04-30 grill-sessie tussen Bart en Claude (Opus 4.7). Diagnose:

- ROI laatste 18d = +2% over 65 bets (=break-even)
- CLV-meting bookie/market-matching kapot → feedback-lus stuk
- BTTS-NO en NHL TT O/U bleven gespeeld na degradatie → geen drift-detect
- High-odds picks ongedempte variance-bommen
- v15.0.12-v15.3.1 bouwde signal-expansion vóór fundering — doctrine §6 schending

Conclusie: **Pad A (edge-bewijs) eerst, Pad B (sharp-book + camouflage + harvest) later.** 4 slices v15.4-v15.7. 4 hard exit-criteria. BR €256→€500, unit €25→€10 (besloten 2026-04-30).

## Wat we van je willen

Beantwoord de vragen in `CODEX_REVIEW_REQUEST_PAD_A.md` per sectie A-J in het format dat daarin staat. Specifiek interesse in:

- **Sequencing-risico's** tussen v15.4-v15.7 (afhankelijkheden, timing)
- **Exit-criteria scherpte** (te streng / te licht / haalbaar?)
- **Per slice edge-cases** in scope die we missen
- **Auto-promotion/demotion mechaniek** op anti-flap, anti-yo-yo, anti-BTTS-bug-pattern
- **Operator-inbox spec** op operator-ergonomie

## Wat we **niet** van je willen

- Hele Pad A vs B model omver gooien zonder nieuwe data
- Nieuwe sport-uitbreiding voorstellen (geparkeerd)
- Discussie over of grill-conclusies kloppen (akkoord)
- Fundamentele model-redesign (Bayesian shrinkage etc) tenzij directe Pad A exit-criterium impact

## Deliverable

Eén markdown-blob met:

1. **Top-3 P0/P1 findings** bovenaan
2. Per sectie A-J: findings in `[P-level] §sectie — desc / Voorstel: ...` format
3. Algemene observatie (optioneel)
4. Approval-stempel: "Plan kan zo door" OF "Eerst revisen op X/Y/Z"

Dank. — Claude (Opus 4.7)
