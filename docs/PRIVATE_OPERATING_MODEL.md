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

## 6. Actieve roadmap

De roadmap is niet feature-first maar edge-first. Elke fase moet de scanner
inhoudelijk scherper maken of de discipline-lus veiliger maken.

### Fase 1 — Scanner-core hard maken

Doel: de knop betrouwbaarder en testbaarder maken.

Prioriteiten:
- pick-ranking, signal attribution en market parsing verder uit `server.js` halen
- per sport één gedeelde ranking/selection flow waar mogelijk
- regressietests toevoegen voor ranking, stake tiers, audit-damping en no-bet gates
- bookie-resolution, line-selection en closing-line matching verder harden

Succescriterium:
- minder drift tussen modules
- sneller veilig itereren op ranking/signalen
- geen stille regressies in stake of pick-selectie

### Fase 2 — Execution edge verdiepen

Doel: betere picks door betere timing en context, niet door meer cosmetische score.

Prioriteiten:
- line-move timing signalen: open → current → pre-kickoff → close
- market disagreement per bookie-cluster: soft vs sharp vs preferred
- injury recency / lineup certainty / goalie-pitcher confirmation dichter op kickoff
- rust/reis/asymmetrie-signalen per sport waar point-in-time data betrouwbaar is

Succescriterium:
- hogere CLV zonder dat pickvolume kunstmatig wordt opgevoerd
- meer “skip” waar de markt of context te onduidelijk is

### Fase 3 — Learn-lus strakker maken

Doel: het model niet alleen laten leren, maar correct laten leren.

Prioriteiten:
- signal performance per sport, markt, timing-window en bookmaker-context
- onderscheid tussen absolute CLV, excess CLV en execution quality
- strengere sample-size discipline voor weight-updates, step-ups en kill-switches
- operator-zicht op waarom een signaal momenteel trusted, muted of watchlist is

Succescriterium:
- minder ruis in autotune
- duidelijker bewijs waarom een signaal stijgt of zakt
- compounding-lussen reageren op echte edge, niet op variance

### Fase 4 — Bankroll en compounding engine

Doel: winst beter behouden en opschalen.

Prioriteiten:
- historisch expliciete money-state per bet waar nodig (`unit_at_time`, bankroll-context)
- strengere step-up/step-down regels op basis van CLV, ROI en drawdown samen
- duidelijk onderscheid tussen exploratory picks en proven-edge picks
- projectie/logica die bankrollgroei ondersteunt zonder te vroeg aggressief te worden

Succescriterium:
- minder regimefouten bij unitwissels
- step-ups alleen na bewezen edge
- betere overleving bij drawdowns

### Fase 5 — Automation zonder cockpit-ziekte

Doel: minder handwerk, zonder extra productruis.

Prioriteiten:
- scans, checks, cleanup en monitoring waar mogelijk automatisch
- alleen operator-alerts voor echte uitzonderingen: drawdown, source-failure, drift, CLV-regime-shift
- geen dashboards bouwen die vooral “interessant” zijn maar geen actie sturen

Succescriterium:
- minder handmatige checks
- minder cognitieve load
- operator grijpt alleen in wanneer het systeem daar bewijs voor geeft

## 7. Wat we bewust niet najagen

Niet prioriteren:
- multi-user tiers, billing of platformisering
- explainability die teveel model-internals prijsgeeft
- exotische markten zonder bewezen executionvoordeel
- volume verhogen als CLV/discipline daar niet beter van wordt
- features die vooral mooi lijken in UI maar geen scan- of bankrollwinst opleveren

## 8. Beslisregel voor nieuwe signalen

Een nieuw signaal komt pas op de roadmap als we aannemelijk kunnen maken dat het:
- point-in-time beschikbaar is
- sport- en markt-specifiek genoeg is om echte extra informatie te bevatten
- meetbaar kan worden teruggekoppeld via CLV of executionkwaliteit
- en de scan helpt vaker goed te skippen, niet alleen vaker te selecteren
