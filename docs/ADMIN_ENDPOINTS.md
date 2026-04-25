# Admin endpoints · operator quick reference

**Laatste update:** 2026-04-25 (v12.2.38)

Alle endpoints zijn `requireAdmin`-gated. Browser-console pattern:
```js
fetch('/api/admin/v2/<endpoint>', {
  headers: { Authorization: `Bearer ${localStorage.getItem('ep_token')}` }
}).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2)))
```

## Diagnostiek (read-only)

### `/admin/v2/scan-by-sport?hours=12`
Per sport: total candidates, accepted, rejected, top-5 reject-reasons, byMarket breakdown. Beantwoordt "waarom 0 voetbal/2 hockey?"-vragen.

### `/admin/v2/pick-distribution?hours=24[&preferredOnly=1]`
Per market_type × bookie: total/accepted/rejected/byReason. Vergelijkt acceptance-rate over bookies.

### `/admin/v2/sharp-soft-windows?lookahead_hours=24&min_gap_pp=0.02[&include_mirror=1]`
Execution-edge windows: waar soft-book (preferred) gunstigere prijs heeft dan sharp consensus. Default filtert mirror-side weg (alleen actionable kant).

### `/admin/v2/devig-backtest?hours=24&min_bookmakers=3[&sharp_only=1]`
Vergelijkt log-margin vs proportional devig op recente odds_snapshots. Gebruik wekelijks om te zien of swap-default zinvol is.

### `/admin/v2/model-brier?days=90`
Model Brier vs market Brier op overlap-set (joined bets ↔ pick_candidates). Bij ≥30 join-matches: head-to-head + interpretation. Triggert R3 Bayesian beslis-pad.

### `/admin/v2/concept-drift?source=pick_ep&min_n=20&drift_threshold=0.02`
Per (signal × sport × market): brier30 vs brier90 vs brier365. Detect signals waar recente prestatie significant slechter is dan langere baseline → mogelijke drift.

### `/admin/v2/calibration-monitor?window=90d&sport=football`
Per-signaal Brier/log-loss/calibration-bins. Filter op probability_source='pick_ep' voor canonical (vs ep_proxy legacy).

### `/admin/v2/snapshot-counts?hours=24`
Health-check op v2 snapshot tabellen (fixtures, odds_snapshots, feature_snapshots, market_consensus, model_runs, pick_candidates).

### `/admin/v2/execution-quality?fixture_id=X&market_type=Y&selection_key=Z`
Punt-in-tijd execution analyse per fixture/markt/selection: stale check, drift, gap, overround.

### `/admin/v2/data-quality`
Feature_snapshots + odds_snapshots freshness/issue summary.

### `/admin/v2/per-bookie-stats`
ROI + CLV per bookmaker uit settled bets.

### `/admin/v2/market-thresholds`
Adaptive MIN_EDGE per markt tier.

### `/admin/v2/odds-drift`
Odds drift-per-bucket t.o.v. close (research-tool).

### `/admin/v2/bookie-concentration`
Open bets per bookie + payout-exposure.

## Acties (write)

### `POST /api/admin/v2/autotune-clv`
Trigger handmatige CLV-based signal weight tuning (zelfde code-pad als 6-hourly cron).

### `POST /api/clv/backfill`
Vult CLV-velden voor bets zonder CLV (rate-limited 200ms/bet).

## Auto-alerts (achtergrond)

### Sharp-soft execution windows (15 min cron)
Stuurt push notification + inbox alert wanneer een window opent met gap ≥ 4pp en kickoff binnen 6u. Cap 5 alerts per check tegen burst-spam. Dedup via `notifications.body` startsWith `sharpsoft:...`.

### Kill-switch (30 min cron)
Auto-disable markt bij avg CLV < -5% over ≥30 settled bets. Notification bij block + restore.

### Pre-kickoff drift check (per bet)
30 min vóór aftrap: vergelijkt logged odds met huidige preferred-bookie best price. Drift-alert ±8%.

### Calibration monitor (daily)
Aggregeert settled bets → signal_calibration. Probeert canonical pick_ep via bet↔pick join, fallback ep_proxy. Beide sources naast elkaar in tabel sinds v12.2.27 migratie.

### Heartbeat (per scan-window)
07:30/14:00/21:00 CEST: alert als geen scan output of geen picks ondanks volume.

## Veilige tunables (admin-only setting via UI of POST endpoint)

- `unitEur`, `startBankroll` — `/api/admin/money-settings`
- `kellyFraction` — `/api/admin/kelly-fraction` (range 0.10-1.00, max-auto 0.75)
- `preferredBookies` — user-settings
- Kill-switch override — `/api/admin/kill-switch`
