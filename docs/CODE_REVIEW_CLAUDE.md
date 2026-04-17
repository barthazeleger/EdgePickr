# EdgePickr Deep Code Review — Claude

Datum: 2026-04-17 | Scope: volledige codebase | Reviewer: Claude

Onafhankelijk review-document. Codex heeft een apart document geschreven.
Samenvoeg-fase volgt nadat Bart beide documenten doorstuurt.

---

## P0 — Security (kritiek, direct actie vereist)

### P0-1. `const _marketSampleCache` reassignment breekt adaptive edge — LIVE BUG
**server.js:161/173** — `_marketSampleCache` is `const` maar wordt op regel 173 reassigned. In strict mode crasht dit met `TypeError`, maar de `catch {}` swallowed het. Gevolg: `_marketSampleCache` wordt NOOIT gerefresht → `adaptiveMinEdge()` ziet altijd `totalSettled=0` → alle markten gebruiken base `MIN_EDGE` i.p.v. de strengere 8%/6.5% tiers. Dit is een **actieve correctness-bug** die risicobescherming stilletjes uitschakelt.
**Fix:** `const` → `let` op regel 161.

### P0-2. SSRF guard bypassbaar via hex/octal IP-notaties
**scraper-base.js:62-69** — De SSRF-blocklist matcht alleen decimale IP-ranges. Bypass mogelijk via `0x7f000001` (hex), `0177.0.0.0` (octal), `2130706433` (decimal-encoded), of `[::ffff:127.0.0.1]` (IPv4-mapped IPv6).
**Fix:** Na `new URL(url)`, resolve hostname en check parsed IP. Of gebruik een DNS-resolution check.

### P0-3. `nhl-goalie-preview.js` gebruikt raw `fetch()` zonder SSRF guard
**nhl-goalie-preview.js:69** — `fetch()` met `encodeURIComponent(gameId)` maar geen URL-validatie via `safeFetch`. Als `gameId` user-controllable is, kan het interne services raken.
**Fix:** Gebruik `safeFetch` met `allowedHosts: ['api-web.nhle.com']`.

### P0-4. `config.js` exporteert ADMIN_PASSWORD en Telegram bot token
**config.js:17-18** — `ADMIN_EMAIL` en `ADMIN_PASSW` zijn `module.exports`. Elk bestand dat `require('./config')` doet krijgt plaintext admin-credentials. Als een debug-endpoint de config serialiseert, lekken ze.
**config.js:30** — `TG_URL` bevat de bot token inline en wordt geëxporteerd.
**Fix:** Exporteer `ADMIN_PASSW` niet. Bouw een `validateAdminPassword(input)` functie. Bouw `TG_URL` at call-time.

### P0-5. `/api/status` is publiek en lekt operationele intelligence
**server.js:8958** — Endpoint staat in `PUBLIC_PATHS` (geen auth). Returnt `afRateLimit.remaining`, per-sport call counts, model `totalSettled`, `totalWins`, `marketsTracked`, en league-configuratie. Concurrent of kwaadwillende kan API-gebruik en model-confidence zien.
**Fix:** Verwijder uit `PUBLIC_PATHS` of strip model/API-stats uit publieke response.

### P0-6. Supabase `.or()` met user-controlled UUID — injection-risico
**server.js:6614** — `query.or(\`user_id.eq.${req.user.id},user_id.is.null\`)` interpoleert JWT-payload direct in PostgREST filter. Ondanks JWT-signing is dit defense-in-depth violation. Zelfde patroon op regels 9334, 9349, 9365.
**Fix:** Valideer `req.user.id` als UUID (`/^[0-9a-f-]{36}$/i`) vóór interpolatie, of gebruik `.in()` met explicit null handling.

### P0-7. 2FA code gebruikt `Math.random()` — niet cryptografisch veilig
**server.js:6316** — `Math.floor(100000 + Math.random() * 900000)` is voorspelbaar als PRNG-state bekend is.
**Fix:** `crypto.randomInt(100000, 999999)`.

### P0-8. `rateLimitMap` groeit onbegrensd — memory-based DoS
**server.js:294-302** — Map entries worden nooit geëvict. Elke unieke IP+action combinatie groeit permanent. Geen cleanup-interval (anders dan `loginCodes` op regel 376).
**Fix:** Periodiek (10-15 min) entries verwijderen waar `now > entry.resetAt`.

### P0-9. Geen RLS op enige Supabase tabel — defense-in-depth ontbreekt
**Alle migraties** — Geen `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` op bets, fixtures, odds_snapshots, signal_calibration, etc. Als de anon key lekt (of client-side per ongeluk wordt gebruikt), is alle data lees- en schrijfbaar.
**Fix:** RLS enablen op alle tabellen + policies voor service_role.

---

## P1 — Correctness (hoog, planning vereist)

### P1-1. XSS in zoekfunctie via innerHTML
**index.html:3569** — Zoekquery `q` wordt direct in `<strong>${q}</strong>` geïnjecteerd zonder escaping. `<img src=x onerror=alert(1)>` geeft script-execution. Gecombineerd met JWT in localStorage (P2-4) = sessie-hijacking.
**Fix:** `escHtml(q)`.

### P1-2. XSS in analyse-view via ongeëscapete pick-data
**index.html:3582-3583** — `p.label`, `p.match`, `p.league`, `p.odd`, `p.units` in `doSearch` render-loop zonder `escHtml()`. De reguliere `renderPicks` escape wél, maar dit pad niet.
**Fix:** `escHtml()` op alle geïnterpoleerde velden.

### P1-3. `updateCalibration` mist `sport` veld — alles wordt football
**server.js:6273-6288** — Object naar `updateCalibration` bevat geen `sport` veld. `normalizeSport(undefined)` mapt naar `'football'`. Alle niet-voetbal calibratie-data wordt onder football gebucketed. Stille data-corruptie.
**Fix:** `sport: row.sport || 'football'` expliciet meegeven.

### P1-4. setTimeout-based checks verloren bij process restart
**server.js:7873/7952** — Pre-kickoff en CLV checks zijn puur in-memory scheduled via `setTimeout`. Bij Render free-tier spin-down gaan alle pending checks verloren. Geen recovery-mechanisme.
**Fix:** Scheduled checks in Supabase opslaan, bij boot re-schedulen.

### P1-5. `scanRunning` boolean is geen mutex — race condition
**server.js:7613** — Als SSE-client disconnectte vóór scan klaar is en reconnectte, kan een nieuwe scan starten terwijl de oude nog schrijft naar `lastPrematchPicks`.
**Fix:** Uniek scan-ID, of echte mutex.

### P1-6. Bet ID generatie: `Math.max(...ids) + 1` — race condition
**server.js:8026** — Twee gelijktijdige `POST /api/bets` kunnen dezelfde max-ID lezen en dezelfde next-ID genereren. Geen unique constraint op `bet_id` zichtbaar.
**Fix:** Supabase auto-increment of UUID.

### P1-7. `PUT /api/bets/:id` accepteert arbitraire `sport` waarde
**server.js:8060** — `sport` uit `req.body` wordt zonder validatie geschreven. Breekt `normalizeSport()` en vervuilt calibratie.
**Fix:** Whitelist-validatie op sport.

### P1-8. Parallel scans delen mutable counters
**server.js:7428-7434** — `h2hCallsThisScan`, `weatherCallsThisScan`, `afCache` worden concurrent gelezen/geschreven in `Promise.all`. Async yields veroorzaken interleaving.
**Fix:** Per-scan counter-objecten i.p.v. gedeelde globals.

### P1-9. `config.js:72` — `clamp()` bakt `Math.round()` in
Callers die fractional probability verwachten (67.3%) krijgen 67. `calcWinProb` en `calcOverProb` returnen onnodig grove integers.
**Fix:** Round verwijderen uit clamp, callers laten ronden.

### P1-10. `picks.js:61` — Kelly-formule inline dupliceert `model-math.js:calcKelly`
Dubbel onderhoud, divergentie-risico.
**Fix:** `calcKelly(ep, odd)` direct aanroepen.

---

## P2 — Quality (medium, refactor)

### P2-1. Duplicate Poisson-implementatie in server.js
**server.js:2025-2063** — Lokale `factorial()`, `poissonProb()`, `calcGoalProbs()` terwijl `poisson`/`poissonOver`/`poisson3Way` al geïmporteerd zijn.

### P2-2. Re-exports van odds-parser functies via picks.js
**picks.js:223-228** — Twee import-paden voor dezelfde functies.

### P2-3. `KELLY_FRACTION` constant is stale snapshot
**model-math.js:287** — Exporteert initiële waarde 0.50. Als `setKellyFraction()` de runtime-waarde wijzigt, is de constant verouderd.

### P2-4. JWT in localStorage — XSS-toegankelijk
**index.html:8 + js/auth.js:4** — `ep_token` in localStorage. Gecombineerd met P1-1/P1-2 XSS = sessie-hijacking.

### P2-5. `calibration-store.js:save()` schrijft nooit naar lokaal bestand
Supabase save + cache update, maar lokale fallback-file wordt nooit bijgewerkt → permanent stale.

### P2-6. `epBucketKey` gedupliceerd in config.js en model-math.js

### P2-7. Static file serving vanuit project root
**server.js:421** — `express.static(path.join(__dirname))` serveert hele project-directory. Whitelist-filter dekt af, maar beter uit een dedicated `public/` dir.

### P2-8. Attribute-context injection in onclick handlers
**index.html:2162,4289** — `onclick="editSport(${b.id},'${escHtml(b.sport)}')"` — `escHtml` escaped geen quotes voor attribute-context.

### P2-9. Test shadows maskeren echte functies
**test.js:871-927** — Lokale `detectMarket` is simpeler dan de geïmporteerde productie-versie.

### P2-10. Geen tests voor 8 lib-modules
`auth.js`, `config.js`, `db.js`, `leagues.js`, `telegram.js`, `weather.js`, `api-sports.js` — inclusief security-critical `auth.js`.

---

## P3 — Performance (laag, optimalisatie)

### P3-1. Drie separate full-table scans op bets (elke 30 min)
`refreshKillSwitch`, `refreshMarketSampleCounts`, `refreshSportCaps` doen elk `select(*)` op hele bets-tabel.

### P3-2. `saveAfUsage()` op elke API-sports call → 600+ Supabase writes per scan
Debounce/batch naar 1x per 30-60 sec.

### P3-3. `checkOpenBetResults` user-triggerable → 12 API calls per klik zonder rate limit

### P3-4. `snapshotAggregate` O(N) in move-detection loop
Pre-compute aggregates voor alle clusters in één pass.

### P3-5. `nhl-goalie-preview` cache onbegrensd — gebruik `TTLCache`.

### P3-6. `odds_snapshots` geen retention/TTL mechanisme — grow unbounded.

### P3-7. Season-berekening eenmalig bij startup — stale bij jaar-overgang
**server.js:1079** — `CURRENT_SEASON` nooit geüpdatet.

---

## P4 — Doctrine (informatief)

### P4-1. CSP gebruikt `unsafe-inline` — nodig door monolitische inline script
### P4-2. `manifest.json` mist `"scope": "/"`
### P4-3. `xlsx@0.18.5` heeft bekende CVEs (prototype pollution)
### P4-4. `global.fetch` mock in tests nooit restored via `finally`
### P4-5. Geen FK constraint zichtbaar op `bets.user_id`
### P4-6. `fixtures` nullable kolommen die altijd gevuld zouden moeten zijn

---

## Samenvatting

| Prio | Aantal | Kernthema's |
|------|--------|-------------|
| P0 | 9 | SSRF bypass, credential export, XSS + JWT combo, RLS ontbreekt, live adaptive-edge bug, public API intel |
| P1 | 10 | XSS, calibratie-corruptie, race conditions, precision loss, Kelly-duplicatie |
| P2 | 10 | Dode code, duplication, test-gaten, stale exports |
| P3 | 7 | Full-table scans, API-call waste, unbounded caches |
| P4 | 6 | CSP, dependency CVEs, manifest, FK constraints |

**Meest urgente actie-items:**
1. **P0-1** — `const` → `let` op `_marketSampleCache` (1-regel fix, live bug)
2. **P0-4** — Stop export van ADMIN_PASSW en TG_URL met token
3. **P0-9** — RLS enablen op alle Supabase tabellen
4. **P1-1/P1-2** — XSS fixen in search + analyse view (gecombineerd met JWT in localStorage = sessie-hijacking)
5. **P1-3** — Sport-veld meegeven aan updateCalibration (stille data-corruptie)
