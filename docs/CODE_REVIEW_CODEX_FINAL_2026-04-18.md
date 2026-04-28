# EdgePickr Code Review

Date: 2026-04-18  
Reviewer: Codex  
Repo state reviewed: current local `v11.1.0` checkout

## Scope

This review covered the active codebase end-to-end, with emphasis on:

- authentication and authorization boundaries
- user isolation and mutation safety
- results-settlement correctness
- stake-regime / bankroll-discipline logic
- scan / scheduler automation
- frontend rendering and XSS-sensitive patterns
- execution-truth, playability, CLV, calibration, and automation interactions
- repo structure, CI, and maintainability drift

I also ran the full test suite locally after closing three live issues found during this pass.

Result:

- `npm test` -> `571 passed, 0 failed`

## Executive Summary

This is materially stronger than the late monolithic codebase.

The repository now has:

- real CI (`.github/workflows/ci.yml`)
- meaningful modularization in `lib/`, `lib/integrations/`, and `lib/runtime/`
- a serious execution-quality / CLV / calibration / stake-discipline feedback loop
- far better security posture than the earlier audit baseline
- a test suite that is no longer symbolic, but operationally useful

I do **not** think the codebase justifies “best tool known to mankind” rhetoric. I **do** think it now qualifies as a serious, well-instrumented private operator betting system with genuine automation and real discipline layers.

It is also still clearly:

- a **single-operator** system, not a general multi-tenant platform
- **high automation with human execution**, not “no operator in the loop”
- still constrained by a large `server.js` and a frontend that remains too dependent on `innerHTML` and inline event patterns

## Findings

### [P1] Remaining frontend attack surface is still too dependent on inline handlers and `innerHTML`

The riskiest previously known XSS paths were reduced, but the general rendering model is still structurally fragile:

- the app still uses many inline `onclick="..."` handlers throughout the page shell and tracker table (`index.html:33-52`, `index.html:2201-2221`)
- scan rendering still builds large HTML fragments with `innerHTML` (`index.html:1485`, `index.html:1554`)
- analysis error suggestions still inject executable inline handler source using dynamic match text (`index.html:3560-3571`)
- search results still render with `innerHTML` for full pick cards (`index.html:3791-3805`)

This is no longer the same “obvious live exploit” posture as before, but it remains a design-level security and maintainability weakness. The current code relies on many local escaping conventions staying perfect forever.

**Recommendation**

- continue migrating interactive UI paths to DOM APIs + event delegation
- reserve `innerHTML` for trusted static shells only
- treat “remove inline executable attributes” as a real hardening epic, not cosmetic cleanup

### [P1] `server.js` and `lib/db.js` still duplicate core bet persistence paths

The repo now has a shared DB layer, but the split is incomplete:

- `server.js` still defines `readBets`, `writeBet`, `updateBetOutcome`, and `deleteBet` (`server.js:6750-6859`)
- `lib/db.js` also defines `readBets`, `writeBet`, and `deleteBet` (`lib/db.js:140-210`)

This is not an abstract style concern. It is exactly the kind of duplication that historically caused user-scope drift and schema-fallback drift in this project.

The current review pass already had to fix bet-owner mapping in both places to keep global results-check safe.

**Recommendation**

- finish collapsing bet persistence into one authoritative implementation
- keep server orchestration in `server.js`, but move canonical data read/write/update semantics behind one shared module

### [P2] Config/auth constants still have stale duplication and can drift again

The local server auth boundary is correct now:

- `server.js` public paths exclude `/api/status` (`server.js:486-487`)

But `lib/config.js` still exports an older `PUBLIC_PATHS` set that *includes* `/api/status` (`lib/config.js:150-152`, `lib/config.js:194`).

That mismatch is not a live auth bypass today because `server.js` uses its own local `PUBLIC_PATHS`, but it is a maintainability footgun. It creates a false source of truth in exactly the kind of file future refactors are likely to trust.

**Recommendation**

- either remove `PUBLIC_PATHS` from `lib/config.js`
- or make `server.js` import the one canonical value from a single auth/config module

### [P2] Scheduler automation is stronger, but still not durable infrastructure

Automation is real and broad:

- daily results check
- daily scans
- odds monitor
- kickoff polling
- health alerts
- retention cleanup
- auto-tuning
- stake-regime boot recalculation

But the orchestration is still based on in-process timers and boot-time rescheduling (`server.js:11994-12029`, `server.js:12252-12355`).

That is good enough for a private single-process Render deployment, but it is not durable workflow infrastructure. If the process sleeps, restarts, or is delayed during a critical window, behavior still depends on restart timing and compensating logic.

**Recommendation**

- keep current timers for now if operationally acceptable
- do not oversell this as durable automation
- if reliability expectations rise, move critical jobs to persisted scheduling / queue-backed execution

## Strengths

### 1. CI is now real

The repo now has an actual GitHub workflow:

- `.github/workflows/ci.yml` installs dependencies, runs `npm audit --audit-level=high`, runs tests, and attempts coverage (`.github/workflows/ci.yml:1-34`)
- `package.json` also exposes `test:coverage` and `audit:high` explicitly (`package.json:6-10`)

This is a meaningful improvement over the earlier state where CI claims were not visible in-repo.

### 2. Doctrine and code are much more aligned

The prep/docs now honestly frame the product as:

- a **private single-operator betting terminal** (`docs/CODE_REVIEW_PREP.md:7-10`)
- with explicit reviewer focus on stake-regime thresholds, execution-gate interaction, preferred-bookie audits, and autotune interactions (`docs/CODE_REVIEW_PREP.md:121-125`)

That matches the code much better than broader “full autonomous platform” language would.

### 3. The learning loop is no longer superficial

The system now genuinely combines:

- CLV and sharp-reference tracking
- execution-quality and preferred-gap logic
- calibration/Brier/log-loss
- stake-regime throttling
- signal autotune and CLV-based adjustments
- post-scan execution/playability gating

That is not cosmetic. It reflects a real attempt to make the system self-correcting instead of just heuristically noisy.

### 4. Security posture is materially better than before

Important improvements that now exist in the codebase:

- DB-backed `requireAuth()` with live status/role checks (`server.js:489-514`)
- `/api/status` removed from active public-path handling (`server.js:486-487`)
- CI audit gate exists
- push scoping, results-check user ownership, and UUID hardening were all improved recently

This repo is not “done” on security, but it is no longer casually porous the way it once was.

## Functional Audit Notes

### Results-settlement and tracker sync

The auto-settle pipeline is much better than it was. The move into `lib/runtime/results-checker.js` and the expanded tests are good signs.

During this review I found and fixed three real issues:

1. global results-check could still mutate bets without owner scoping
2. stake-regime could still read all users’ settled history
3. live tracker sync missed irreversible `Under` losses

Those are now closed in the local reviewed state. Details are listed in “Changes made during this review” below.

### Stake regime

The stake engine is now serious enough to deserve real scrutiny rather than dismissal.

What I like:

- explicit regime logic exists
- bankroll metrics are isolated in `lib/stake-regime.js`
- the code and tests clearly treat this as the runtime risk spine, not a vanity metric

What still needs discipline:

- thresholds still look doctrinally chosen rather than empirically validated
- recomputation cadence is still scheduler/scan-driven rather than truly event-driven
- if the project ever drifts back toward multi-user use, stake scope must stay aggressively single-operator

### `Over 2.5` / Bet365 / Unibet pattern

Your observation that many surfaced picks look like “Over 2.5 with Bet365” or “No picks today with Unibet” is **plausible as a structural outcome of the current pipeline**, not necessarily random coincidence.

Contributing reasons I see in code:

- `adaptiveMinEdge()` becomes stricter for under-sampled markets, which naturally favors broad high-history markets (`server.js:250-261`)
- totals, especially `Over 2.5`, are deeply supported in football model logic (`server.js:6018-6045`)
- live logic also has an explicit `Over 2.5` scenario (`server.js:6614-6618`)
- consensus pools intentionally widen around preferred bookies plus sharp references (`server.js:5595-5605`)
- post-scan gating is explicitly preferred-bookie aware (`server.js:3141-3150`)

My read:

- I do **not** see a trivial “always prefer Bet365” hardcode
- I **do** see a pipeline that naturally rewards broad, proven totals markets and surfaces only picks with executable preferred-bookie pricing
- if Unibet has weaker coverage or misses the actionable price more often, “no picks today” can absolutely be a real downstream outcome

This is worth measuring empirically, but it does not currently look like a single obvious bug.

## Repo Structure Assessment

The structure is better than before.

What improved:

- `lib/integrations/` is a meaningful grouping for provider/source logic
- `lib/runtime/` is a good home for results-check, scan-gate, live-board, and operator helpers
- CI, docs, and the prep material now make the repo easier to review honestly

What remains weak:

- `server.js` is still the dominant operational brain
- `index.html` is still a very large monolithic frontend
- persistence/config concerns are not yet fully centralized

So the repo is now **better organized**, but not yet architecturally “clean.”

## Overall Verdict

This codebase has crossed the line from “interesting private project” into “serious operator system.”

That does **not** mean:

- perfect
- fully autonomous
- formally robust under every operational regime
- free of security debt

It **does** mean:

- the automation is real
- the learning loop is real
- the security and correctness work has been substantial
- the repo is now worth reviewing as production-like software rather than hobby glue

My honest rating:

- product direction: strong
- automation maturity: strong for a single-process private operator tool
- security posture: materially improved, still not finished
- architectural cleanliness: improved, still constrained by `server.js` and `index.html`
- truthfulness of the strongest marketing claims: still overstated unless phrased as “automated learning loop with human execution”

## Changes made during this review

I did not just audit. I also closed three live issues during this review pass:

1. **Global results-check owner scoping**
   - `checkOpenBetResults()` now uses the actual bet owner (`bet.userId`) when running in global mode, instead of updating and notifying with `userId = null`
   - affected files:
     - `server.js`
     - `lib/db.js`

2. **Stake-regime single-operator scoping**
   - `recomputeStakeRegime()` and the admin preview endpoint now scope settled bets to the admin user plus legacy `user_id IS NULL` rows, instead of reading all users’ settled history
   - affected file:
     - `server.js`

3. **Early live tracker sync for irreversible `Under` losses**
   - the frontend now triggers tracker sync as soon as an `Under` line is mathematically broken live, instead of waiting for full time
   - affected file:
     - `index.html`

4. **Regression coverage**
   - added a test to ensure `db.readBets()` preserves `userId`, which is necessary for safe global results-check settlement
   - affected file:
     - `test.js`

Validation performed after these changes:

- full test suite run locally
- final result: `571 passed, 0 failed`

## Recommended next steps

1. Finish collapsing duplicated bet persistence logic into one canonical module.
2. Continue replacing `innerHTML` + inline handlers in the frontend with DOM/event-delegation patterns.
3. Remove stale config duplication like `lib/config.js` `PUBLIC_PATHS`.
4. If uptime guarantees become stricter, move critical schedules off plain in-process timers.
5. Add empirical reporting for pick distribution by:
   - market type
   - preferred bookie
   - rejection stage
   so bias observations like `Over 2.5` / Bet365 / Unibet can be confirmed with data rather than intuition.
