---
description: Implement a planned slice from PLAN_v15.4-v15.7_PAD_A.md (e.g. /ship v15.4)
---

You are about to implement an EdgePickr Pad A slice. The argument is the version
identifier, e.g. `v15.4`, `v15.5`, `v15.6`, `v15.7`.

Slice to implement: **$ARGUMENTS**

## Activation contract (from PLAN §7)

Follow these steps in order. Do not skip any. Do not deviate from the plan
without asking Bart first.

### 1. Read context

- `docs/PLAN_v15.4-v15.7_PAD_A.md` — the canonical spec for all 4 slices.
  Find the section matching the argument (§5.1 = v15.4, §5.2 = v15.5,
  §5.3 = v15.6, §5.4 = v15.7).
- `CHANGELOG.md` — last 5 entries to match style and detect dependencies.
- `docs/PRIVATE_OPERATING_MODEL.md` — active doctrine, do not violate.
- `docs/CODEX_REVIEW_RESPONSE_PAD_A.md` — Codex' aanscherpingen die in plan
  v2 verwerkt zijn. Verifieer dat je ze respecteert tijdens implementatie.
- The "Files (verwacht)" list in the slice section — read each one before
  modifying.

### 2. Verify gating conditions

Before starting v15.6 or v15.7, check the gating in PLAN §5.3 / §5.4:

- **v15.6 requires**: v15.5 in production ≥14d AND rolling 14d match-rate ≥80%.
  If not met, ship in shadow/read-only mode (drift-detector evaluates + logs but
  performs no demote action).
- **v15.7 requires**: v15.6 in production ≥21d.

If a gating condition fails, stop and report to Bart instead of proceeding.

### 3. Implement the slice

- Implement everything in the "Scope" section of the slice
- Create files listed in "Files (verwacht)" — note that paths may shift; if
  a file already exists in a different location, reuse it instead of creating
  a duplicate
- Run any required migrations: place SQL in `docs/migrations-archive/` and
  add a "Post-deploy actie" note in the CHANGELOG entry telling Bart to run
  `node scripts/migrate.js docs/migrations-archive/<file>.sql`
- New helpers go to `lib/` modules, not to `server.js` (per memory:
  modular-from-start, server.js shrinks monotonically from v11 onward)
- Pure functions get unit tests; async tests via `runAsyncTests()` queue

### 4. Test + audit

- `npm test` must pass — current baseline ≥933 tests, plus the new tests
  required by the slice's "Tests" line
- `npm run audit:high` must show 0 high/critical vulnerabilities
- `node --check` on every modified `.js` file (syntax sanity)

If any of these fail, fix the root cause — do not skip hooks (`--no-verify`)
and do not commit broken state.

### 5. Version bump (6 locations — all must match)

Bump from current version to **$ARGUMENTS**:

1. `lib/app-meta.js` — `APP_VERSION` constant
2. `package.json` — `version` field
3. `package-lock.json` — top-level `version` + nested edgepickr `version`
4. `index.html` — 2 places (search for current version string)
5. `README.md` — version reference
6. `docs/PRIVATE_OPERATING_MODEL.md` — "Laatste update" line at top

Plus: `test.js` `appMeta.APP_VERSION` assertion if it pins the version.

### 6. CHANGELOG entry

Format follows existing entries (Keep a Changelog NL 1.1.0). Required sections:

```markdown
## [$ARGUMENTS] - YYYY-MM-DD

**<one-line summary>**

Aanleiding: <waarom deze slice nu, link naar plan §X.Y>

### Added
- ...

### Changed
- ...

### Deferred (indien van toepassing)
- ...

### Tests
- N/N groen (was M/M, +K voor <reden>)

### Verificatie
- `node --check` schoon
- `npm run audit:high` 0 vulns
- Scan-log toont `<expected telemetry line>`

### Post-deploy actie (indien migratie)
- `node scripts/migrate.js docs/migrations-archive/<file>.sql`
- Eventueel env-var: `NEW_FLAG=1` in Render
```

### 7. Commit + push

- Commit prefix:
  - `[claude+codex]` if the slice incorporates Codex review findings (true for
    v15.4-v15.7 since plan v2 absorbed Codex' 5 findings)
  - `[claude]` if pure Claude work
- Commit message: WHAT/WHY/IMPACT body, multi-paragraph allowed
- Use HEREDOC format (see CLAUDE.md commit example)
- Co-Authored-By line: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

**Do not push during scan windows:** 07:30, 14:00, 21:00 Amsterdam ±15min.
Check `new Date()` in Europe/Amsterdam timezone before pushing. If inside a
window, wait until clear and post a notice to Bart.

### 8. Summary back to Bart

Brief end-of-turn message:

- Ship status (committed + pushed, or blocked + why)
- Telemetry line that should appear in next scan-log (so Bart can verify)
- Post-deploy actions Bart must do (env-vars, migrations)
- Next slice + its gating condition (e.g. "v15.5 wacht tot v15.4 14d in
  productie + match-rate baseline gemeten")

## Don't

- Don't lower thresholds (MIN_EP, divergence-gates etc) without CLV evidence
  per CLAUDE.md
- Don't add features beyond the slice scope — Codex finding #5: scope-zuiver
- Don't skip hooks or bypass signing
- Don't commit during scan windows
- Don't commit secrets (.env, credentials)
- Don't write WHAT-comments — only WHY when non-obvious
