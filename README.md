# EdgePickr v13.1.0-pre1

**Private operator betting terminal** voor een single bankroll, een canonieke
scan-state en een CLV-first workflow. Markt = baseline truth, model = residual
overlay. De scanner is het product; de rest bestaat alleen om betere picks,
strakkere discipline en betrouwbaardere learning te ondersteunen.

**v13.0 multi-source pivot** (28-04-2026): drie data-lagen per sport, sport-
uitbreiding van 6 → 9, en API-tier-shift voorbereid voor 13-05-2026.

Geen multi-user SaaS-first denkwijze: EdgePickr optimaliseert voor een private
operator die zo weinig mogelijk handwerk wil, point-in-time correct wil blijven
en alleen features wil die de scan echt scherper of veiliger maken.

Kernprincipes:
- Single-operator correctness boven role/tier-complexiteit
- CLV, execution quality en bankroll discipline boven hitrate-verhalen
- Automation boven cockpit-werk
- Auditability boven black-box "slimme" output
- Liever 0 picks dan 1 valse edge
- **"Dubbele data is altijd goed"** — cross-source validatie boven single-bron-vertrouwen

## v13.0 Multi-Source Architectuur

Per sport drie data-lagen, met fail-soft fallback en cross-source dedup:

| Laag | Bron | Rol | Kosten |
|---|---|---|---|
| 1 | **TheSportsDB Premium V1+V2** | Primair · h2h · standings · lineups · livescores · venues | €9/mnd |
| 2 | **OddsPapi V4** (free) | Odds-feed · 350+ bookmakers (Bet365/Pinnacle/Unibet/WilliamHill/DraftKings/FanDuel/Betfair Exchange/...) · h2h+totals+spreads | Gratis (250/mnd) |
| 3 | **api-sports** | Voetbal Pro vanaf 13-05 ($19,99) · andere sporten free-tier (100/dag) | $19,99 + $0 |

Cross-source disagreement >5% triggert `bookie_anomaly` inbox-warning (v12.4.2 doctrine).

## Features

| Feature | Beschrijving |
|---|---|
| **9 sporten** | Voetbal · basketball (NBA) · honkbal (MLB) · ijshockey (NHL) · American football (NFL) · handbal · **Tennis · Rugby · Cricket** (v13.0 data-laag) |
| **100+ competities** | Alle top-tier leagues per sport, dynamische seizoenen |
| **14 signalen** | Thuisvoordeel, vorm, H2H, blessures, standings, team stats, home/away splits, lineup, referee, API predictions, O/U adjustments, weer, Poisson, fixture congestion |
| **TheSportsDB v13.0** | 13 nieuwe methods: lookuptable (standings), lookuplineup, lookuptimeline, lookupeventstats, lookuptv (TV broadcasts), eventsday/eventslast, lookupvenue, lookup_all_players (roster) + V2 livescore/schedule/full-team |
| **OddsPapi v13.0** | 350+ bookmakers via één API · sharp (Pinnacle/SBOBet) + EU (Bet365/Unibet/WH) + US (DraftKings/FanDuel) + exchanges (Betfair/Polymarket) · h2h/spreads/totals · auto-degrade bij 90% quota |
| **API usage tracker** | Per-source dashboard op /api/status: api-sports tier-shift indicator (13-05), TSDB call-counter (€9 premium), OddsPapi quota-progress (250/mnd) |
| **Poisson model** | Per sport afzonderlijk geijkt — markt-multipliers, EP-buckets en signal-gewichten tunen zich automatisch |
| **Model-vs-market sanity check** | Elke pick wordt gecheckt tegen devigged market consensus; picks waar model > 4% divergeert worden geskipt |
| **3-way ML voor hockey/handbal** | Aparte 60-min regulation markt via bivariate Poisson, naast inc-OT 2-way ML |
| **Preferred bookies** | Edges worden berekend met odds van jouw bookies; consensus blijft market-truth |
| **Kelly sizing** | Half-Kelly · 6 tiers · auto-stepup tot 0.75 bij CLV > 2% + ROI > 5% over 200 bets |
| **CLV tracking** | Closing line odds 2 min voor aftrap, strict bookie match, fuzzy fixture match |
| **PWA** | iOS/Android installatie, offline-cache, Web Push notificaties |
| **Admin panel** | Operator controls, scan history, bankroll settings, debug endpoints, source toggles |
| **Kill-switch** | Auto-disable markt bij avg CLV < -5% over ≥30 settled bets |
| **Walk-forward backtest** | Brier + log loss + calibration buckets per sport/window |
| **Hierarchical calibration** | Bayesian smoothing global → sport → market → league |

## Stack

```
Node.js 20 + Express             Backend
Supabase (PostgreSQL)            Bets, users, scan history, notifications, calibratie
api-sports.io Football Pro       Voetbal · 75.000 calls/dag (vanaf 13-05-2026, $19,99)
api-sports.io free tier          5 sporten · 100 calls/dag elk (vanaf 13-05-2026)
TheSportsDB Premium              9 sporten · 100 req/min · v1+v2 (€9/mnd, sinds 28-04)
OddsPapi v4                      350+ bookmakers · 250 req/maand (free)
ESPN Scoreboard API              Live scores (gratis, onbeperkt)
MLB StatsAPI / NHL public        Sport-specifieke summary-bronnen (gratis)
Web Push (VAPID)                 Operator alerts · picks · CLV · milestones
Render.com                       Hosting + keep-alive
```

## Quickstart

```bash
git clone <repo>
cd edgepickr
npm install
npm start
# Server draait op http://localhost:3000
```

### Environment variables

```bash
# Database
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=<service_role_key>

# Sport data
API_FOOTBALL_KEY=<api-sports.io key>

# Auth
JWT_SECRET=<random 64 hex>
ADMIN_EMAIL=...
ADMIN_PASSWORD=...

# Notificaties (Web Push / PWA)
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_CONTACT=mailto:admin@example.com

# Email (2FA login codes)
RESEND_KEY=...
```

### Deploy op Render

`render.yaml` staat klaar. Voeg environment variables toe via Render dashboard en push naar `master`. Iedere push wordt als productie-waardige wijziging behandeld: kleine diffs, tests eerst, point-in-time correctness altijd leidend.

## CLV backfill (admin)

Voor bets zonder CLV (pre-match check faalde):

```bash
curl -X POST https://<host>/api/clv/backfill \
  -H "Authorization: Bearer <admin jwt>"
```

Rate-limited op 200ms per bet. Return `{ scanned, filled, failed, details }`.

## Testsuite

```bash
npm test     # 634 tests · scanlogica, signals, CLV, security, scrapers, snapshots, regressies, reviewer-bugs, route-integration
```

### Test-categorieën
- Poisson / Kelly / EP buckets — statistische correctheid
- Form / momentum / calibratie — signaal-logica
- Security — error leaking, admin-only endpoints, settings whitelist
- Market-derived probability toolkit — devig, consensus, inc-OT conversion, sanity check
- Input validation — odds, units, fixture IDs

## Engineering standaard

EdgePickr is ontworpen met deze principes:

1. **Niets hardcoded** — constants (thresholds, multipliers, rates) zijn via config of data-derived, met duidelijke TODO-calib markers waar defaults nog handmatig zijn.
2. **Alles dynamisch** — rates, probabilities en aanpassingen komen uit live API-data of historische calibratie, niet uit assumpties.
3. **Testen per feature** — elke nieuwe pure helper krijgt unit tests; bestaande suite moet blijven slagen.
4. **Safety checks overal** — null guards, type coercion, defensive programming. Invalid input returnt `null` ipv crash.
5. **Kwaliteit > volume** — liever 0 picks dan 1 foute pick. Sanity checks en ambiguity guards filtereen aggressief.

## Documentatie

Zie [docs/PRIVATE_OPERATING_MODEL.md](./docs/PRIVATE_OPERATING_MODEL.md) voor de actieve productdoctrine rond scanner, learning en bankroll-discipline.
Zie [docs/RESEARCH_MARKETS_SIGNALS.md](./docs/RESEARCH_MARKETS_SIGNALS.md) voor markt/signal expansion onderzoek.
Zie [docs/REPO_STRUCTURE.md](./docs/REPO_STRUCTURE.md) voor de huidige repo-indeling en modulegrenzen.
Zie [docs/_archive/BUSINESS_PLAN.md](./docs/_archive/BUSINESS_PLAN.md) voor het historische SaaS-plan (gearchiveerd, niet leidend).
Zie [CHANGELOG.md](./CHANGELOG.md) voor versiegeschiedenis.

### Huidige roadmap-focus
- scanner-core modulariseren en drift wegnemen
- execution-edge signalen verdiepen vóór marktverbreding
- CLV/excess-CLV learn-lussen aanscherpen
- bankroll/compounding discipline explicieter maken
- automation verhogen zonder extra cockpit-ruis

### Product thesis
- de markt wordt eerder verslagen op execution timing dan op extra UI
- singles zijn de canonieke output; combi's zijn alleen goed als ze apart gedisciplineerd blijven
- betere odds-history, official news en confirmed starters/lineups zijn waardevoller dan nog meer exotische markten

## Licentie

Private. Alle rechten voorbehouden.
