# Archive Report: starkscan-prover

**Change**: starkscan-prover
**Archived to**: `openspec/changes/archive/2026-09-07-starkscan-prover/`
**Archive date**: 2026-09-07
**Session**: auto, both, stacked-to-main
**Persistence**: hybrid (Engram + OpenSpec)
**Agent**: sdd-archive

## Executive Summary

Starkscan prover integration archived as complete. Delta specs merged to main specs, change folder mechanically archived with byte-identity verified, and final-state facts confirm SDK bundling and secret provisioning blockers resolved via live deployments.

## Final-State Authority

Per skill Final-State Authority hierarchy, this report describes state AT CLOSE, not intermediate snapshot time.

**Rank 1-3 (authoritative final state)** — explicit orchestrator final-state facts:
- Worker deployed successfully to both environments with real SDK `0.14.3-rc.6` (versions `b1dfd9cf-be7a-437d-ad09-aac46abd3977` dev and `865e4a6d-c697-40c2-a715-b63f10e5c7f5` prod) after fixing `file:` path and patching `devnet.js` `fileURLToPath`. Health checks return status healthy.
- `STARKSCAN_API_KEY` secret configured in both workers via `wrangler secret put` (verified via secret list).
- SDK fix commit `cd1032d` pin to `0.14.3-rc.6` committed and pushed.
- All 16 tasks verified 5/5 smoke tests pass, `tsc --noEmit --skipLibCheck` 0 errors (vault-scoped), no console log of secret.
- No remaining blockers for mainnet settlement — prover is mainnet-only, prove scope validated (400 `idempotency_key_required` not 403).

**Rank 4 (intermediate snapshots)** — `verification.md` / `verify-report.md` at 2026-09-07 21:00 (pass_with_warnings):
- Reported WARNING: `file:../../../tmp/opencode/starknet-privacy/sdk` bundling would fail deploy. **Stale** — superseded by final-state facts above (`cd1032d` + live deployments healthy).
- Reported WARNING: `prover-on-demand.ts` health check order diverges from design narrative but still skips Freestyle correctly. **Stale narrative divergence only** — no spec violation, functionally correct per verification coherence matrix.
- Reported untracked openspec files (`??`). **Resolved** — mechanically archived and staged via `git add` in this phase.

No unrankable contradictions found. All stale snapshot claims recorded with source and time per Reporting Rules.

## Task Completion Gate

**Persisted tasks artifact**: `openspec/changes/archive/2026-09-07-starkscan-prover/tasks.md`

- Total: 16, Complete: 16, Incomplete: 0
- All checkboxes `[x]` verified before spec sync.
- Gate: PASS — no stale unchecked tasks.

## Specs Synced

| Domain | Action | Details |
|--------|--------|---------|
| starkscan-proving-provider | Created | 9 requirements, 23 scenarios — full new capability |
| proving-provider-selection | Created | 3 requirements, 6 scenarios — provider priority + mainnet gate |

Target paths:
- `openspec/specs/starkscan-proving-provider/spec.md` — mechanical copy via `cp` + `diff -r` empty
- `openspec/specs/proving-provider-selection/spec.md` — mechanical copy via `cp` + `diff -r` empty

No existing main specs to merge; deltas were full specs per proposal (no existing specs in `openspec/specs/`).

## Archive Contents

| Artifact | Present | Notes |
|----------|---------|-------|
| proposal.md | ✅ | Hybrid phased intent, scope, approach B, risks, rollback |
| exploration.md | ✅ | Starkscan vs mock/self-hosted analysis, Approach B recommendation |
| design.md | ✅ | Wrapper provider, factory, polling, KV persistence, classifier, rate limiter |
| specs/starkscan-proving-provider/spec.md | ✅ | Delta → now also main spec |
| specs/proving-provider-selection/spec.md | ✅ | Delta → now also main spec |
| tasks.md | ✅ | 16/16 complete |
| verification.md | ✅ | pass_with_warnings, 9/9 req, 23/23 scenarios, 5/5 tests |
| verify-report.md | ✅ | Duplicate of verification.md per hybrid persistence |
| config.yaml | ✅ | project zor-privacy-network, persistence hybrid |
| archive.md | ✅ | This report (additive, excluded from diff) |

Active changes directory: `openspec/changes/starkscan-prover` no longer exists ✅

## Source of Truth Updated

`openspec/specs/` now reflects new behavior:
- `openspec/specs/starkscan-proving-provider/spec.md` — async adapter, job submission, polling, once-only persistence, error classification, attestation 300s, rate limiting
- `openspec/specs/proving-provider-selection/spec.md` — env-based routing chain, priority, mainnet gating

## Verification Readback (Mechanical Copy Contract)

Spec sync diffs — **empty (PASS)**:
```
diff -r openspec/changes/starkscan-prover/specs/starkscan-proving-provider/spec.md → openspec/specs/starkscan-proving-provider/spec.md
(empty output — 0 differences)
diff -r openspec/changes/starkscan-prover/specs/proving-provider-selection/spec.md → openspec/specs/proving-provider-selection/spec.md
(empty output — 0 differences)
```

Archive move diff — **empty (PASS)**:
```
diff -r /tmp/sdd-archive.1SdKLe/source openspec/changes/archive/2026-09-07-starkscan-prover
(empty output — 0 differences; archive.md additive excluded per snapshot taken pre-move)
```

Shell mechanism: `cp` + `diff -r` for specs, `snapshot_root` + `cp -R` → `git mv` → `diff -r` for archive. AGENTS.md update verified separately (gap 2 + decision row already present covering StarkscanProofProvider, factory priority, secret, TTL 24h, attestation 265s, rollback).

## AGENTS.md

No edit required in this phase. `AGENTS.md` (2026-09-07) already documents:
- Gap 2: SDK INTEGRATION + Starkscan settlement unlocked via `StarkscanProofProvider` (POST /v1/SN_MAIN/prove → poll, mainnet-only, STARKSCAN_API_KEY > PROVING_SERVICE_URL > mock, TTL 24h + 265s)
- Decision row 2026-09-07: Starkscan prover mainnet (factory priority, KV 24h TTL + attestation 265s, secret never logged, rollback clearing secret)

Verified via `read AGENTS.md` observation.

## Deployment Evidence

Per final-state facts (overriding stale verify WARNING):
- Dev worker `b1dfd9cf-be7a-437d-ad09-aac46abd3977` — healthy
- Prod worker `865e4a6d-c697-40c2-a715-b63f10e5c7f5` — healthy
- Fix: `file:` path replaced with npm registry `0.14.3-rc.6`, `devnet.js` `fileURLToPath` patched
- Secrets: `STARKSCAN_API_KEY` present in both envs (`wrangler secret list`)
- Scope probe: 400 `idempotency_key_required` proves `prove` scope granted (not 403)

## Risks

None blocking. Residual informational:
- Starkscan mainnet-only — Sepolia still requires Freestyle/self-hosted or mock (by design, out of scope for this change).
- External dependency — Starkscan downtime affects settlement; mitigated by queue+retry and mock fallback for non-settlement.
- `prover-on-demand.ts` priority narrative order vs code order — no functional impact, flagged for future clarity.

## Intentional Overrides

None — standard complete archive. No `rules.archive` overrides in `openspec/config.yaml`, no user-requested partial archive.

## Engram Traceability

Observation IDs read for this archive:
- #45 sdd/starkscan-prover/explore
- #46 sdd/starkscan-prover/proposal
- #47 sdd/starkscan-prover/spec
- #48 sdd/starkscan-prover/design
- #49 sdd/starkscan-prover/tasks
- #50 sdd/starkscan-prover/apply-progress
- #51 Starkscan prover final tests + docs (PR4)
- #52 sdd/starkscan-prover/verify-report

New observation: `sdd/starkscan-prover/archive-report` (this report, topic_key `sdd/starkscan-prover/archive-report`, type architecture)

## SDD Cycle Complete

The change has been fully planned, implemented, verified, and archived. Ready for the next change.

**Next recommended**: Top-up flow (gap #4) or rate limiting per AGENTS.md Próximos Pasos — PO to prioritize.
