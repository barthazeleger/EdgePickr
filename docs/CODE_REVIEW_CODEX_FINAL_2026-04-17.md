# EdgePickr Final Code Review

Reviewer: Codex  
Date: 2026-04-17  
Reviewed version: `d5aff8e` (`v10.11.0`)  
Test status at review time: `469 passed, 0 failed`

## Executive Summary

EdgePickr is now a serious private betting system with a much stronger
engineering and product foundation than the earlier codebase. The project has
meaningfully improved in:

- security hardening
- correctness and anti-regression discipline
- execution-vs-market truth separation
- CLV/calibration infrastructure
- operator safety and bankroll discipline
- automated scan / results / feedback workflows

This is no longer “a script with betting heuristics”. It is a real
single-operator betting platform with a growing learning loop.

That said, two kinds of claims should be toned down to match the codebase as it
exists today:

1. **“Fully autonomous / no operator in the loop”** is not an accurate
description of this repository.
2. **“GitHub pipeline / CI is fully in place”** is not evidenced in this repo
state.

The strongest honest description is:

> EdgePickr is a highly automated private operator betting terminal with
> automatic scan, evaluation, calibration, CLV feedback and discipline loops,
> while execution and final operational control remain operator-driven.

That is a strong claim, and the code supports it.

## Scope And Method

This review was performed against the current repository state, not just the
latest diff.

Scope reviewed:

- `server.js`
- `lib/*`
- `lib/integrations/*`
- `lib/runtime/*`
- `index.html`, `js/*`
- `test.js`
- `README.md`
- `docs/PRIVATE_OPERATING_MODEL.md`
- `docs/REPO_STRUCTURE.md`
- `package.json`

Method:

- codebase inspection across runtime, model, security, scheduling and operator
  flows
- architecture review across module boundaries
- consistency review between code, docs and product claims
- verification run of the test suite (`npm test`)

## Overall Assessment

### What is materially stronger than before

#### 1. Product doctrine is clearer and better reflected in code

The repository now has a much more coherent internal logic:

- market truth is treated separately from execution truth
- sharp reference is separate from execution reference
- calibration, CLV and discipline are first-class concerns
- operator safety and bankroll discipline are not bolted on at the end

This matters because the system increasingly behaves like a risk-managed
decision engine, not just a pick generator.

#### 2. Security and correctness are substantially improved

The security review work was not superficial. The codebase now shows real
attention to:

- auth revocation
- user scoping
- push privacy
- route hardening
- RLS defense-in-depth
- SSRF consistency
- XSS reduction on the highest-risk paths
- safer interpolation and validation boundaries

The most important shift is not any single fix, but the fact that the project
has stopped treating security as “edge hardening” and started treating it as a
core runtime concern.

#### 3. The feedback loop is much more credible

The strongest technical improvement is the learning and evaluation stack:

- CLV tracking is sharper
- calibration monitoring exists and is explicit about proxy-vs-canonical state
- execution gating is live
- playability is modeled as a real dimension
- correlation dampening exists
- Bayesian shrinkage is applied more consistently
- sharp reference data is integrated

This is the layer that makes the system feel serious.

#### 4. Testing discipline is a real strength

`469 passed, 0 failed` does not prove the system is perfect, but it does prove
that this repo is no longer relying on vague confidence.

The suite covers:

- model math
- odds parsing
- CLV matching
- execution gating
- calibration metrics
- scraper safety
- source adapters
- security regressions
- runtime/operator helpers
- multi-sport invariants

That level of regression coverage is one of the strongest aspects of the repo.

## Where Claims Overreach The Current Code

### 1. “No operator in the loop” is not accurate

The repository still clearly implements a **single-operator** model, not an
operatorless one.

Evidence in the code and docs:

- the product is explicitly described as a “private operator betting terminal”
- settings remain operator-controlled (`scanEnabled`, `preferredBookies`,
  bankroll/unit settings, 2FA, timezone, scan schedule)
- there are explicit operator failsafes and operator admin endpoints
- scan triggering remains admin/operator bounded
- the UI still exposes operational controls rather than hiding them behind a
  fully autonomous runtime

This is not a flaw. It is a coherent product choice. But the claim should be
adjusted accordingly.

### 2. “GitHub pipeline / CI is in place” is not evidenced here

In the reviewed repository state:

- no `.github/workflows/*` directory was present
- `package.json` exposes only `start` and `test`
- project doctrine still explicitly notes that CI gates are not yet hard
  blocking

If a pipeline exists elsewhere, it is not visible in the repository under
review. Therefore it should not be claimed as a proven part of this codebase
state.

### 3. “Best model/tool known to mankind” is marketing, not engineering truth

The project is strong, but the codebase does not support that kind of claim.

What it does support is:

- strong private operator workflow
- unusually disciplined feedback layers for a private betting stack
- a more credible learning loop than most hobby-grade sports models
- meaningful engineering maturity relative to its earlier state

That is already impressive. It does not need exaggeration.

## Architecture Review

### What is good

The repository structure is noticeably better than before:

- `lib/` contains core betting/model/runtime domain code
- `lib/integrations/` now clearly groups external providers and source adapters
- `lib/runtime/` groups small runtime/operator helpers

This is a meaningful improvement in readability and maintenance.

### What is still the main structural weakness

`server.js` remains the dominant orchestration file and the biggest long-term
maintenance risk.

It still owns too many responsibilities:

- routes
- auth-adjacent decisions