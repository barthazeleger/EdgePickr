# EdgePickr Private Operating Model

Laatste update: 2026-04-16 (v10.10.0)

Dit document is de actieve productdoctrine voor EdgePickr. Niet het oude
SaaS-plan, maar de private operator-workflow is leidend.

## 1. Wat EdgePickr is

EdgePickr is een private betting terminal voor één operator:
- één bankroll
- één canonieke scan-state
- één set preferred bookies
- één waarheid voor bankroll- en unit-logica

Het systeem is geen generiek platform dat voor meerdere users moet voelen als
een complete consumer app. Alles wat niet helpt bij betere scans, betere
execution of betere discipline is bijzaak.

## 2. Hoofddoel

Het doel is niet "meer features", maar structureel betere beslissingen:
- hogere execution quality
- betere CLV
- strakkere bankroll-discipline
- compounding-ready stake logic
- minder handmatig beheer

Een feature is alleen welkom als die minstens één van die punten verbetert
zonder point-in-time correctness of scan-integriteit te beschadigen.

## 3. Productlussen

### Scan
- De knop is heilig.
- Ranking moet draaien op echte edge, niet op cosmetische "confidence".
- Liever 0 picks dan 1 pick met twijfelachtige reasoning of zwakke marktdekking.

### Learn
- Learning moet point-in-time auditbaar zijn.
- CLV is de primaire feedbacklus, niet hitrate.
- Signalen worden beoordeeld op extra waarde boven markt-context, niet op ruwe noise.

### Discipline
- Stake logic moet bankroll-beschermend zijn.
- Step-ups vragen bewijs, niet enthousiasme.
- Alerts en failsafes horen klein, duidelijk en operator-first te zijn.

## 4. Beslisregels voor nieuwe features

Voeg iets alleen toe als het:
1. scan-output aantoonbaar scherper maakt,
2. execution timing verbetert,
3. bankroll/CLV-discpline versterkt,
4. point-in-time auditability verhoogt,
5. of handwerk vervangt zonder canonieke state te vervuilen.

Voeg iets niet toe als het vooral:
- UI-oppervlak vergroot zonder scanwinst,
- multi-user/tiering-complexiteit introduceert,
- reasoning/signals onnodig blootlegt,
- of learning vervuilt met achterafkennis.

## 5. Technische voorkeuren

- Pure scan/helpers eerst naar testbare modules, niet naar meer `server.js`.
- Centrale waarheden voor versie, bankroll-settings en operator-state.
- Kleine, production-safe diffs omdat elke push via Render live kan raken.
- Tests voor scanner, signalen, bankroll-logica en regressies zijn goedkoper dan stille edge-erosie.

## 6. Huidige roadmap-richting

De hoogste prioriteit ligt bij:
- verdere modularisatie van scan- en ranking-logica,
- meer point-in-time signalen met echte executionwaarde,
- strengere bankroll- en CLV-feedbacklussen,
- en automation die de operator ontzorgt zonder extra cockpit-complexiteit.
