# Tasks: starkscan-prover

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 650–750 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 Foundation → PR2 Core → PR3 Integration+Tests |
| Delivery strategy | auto-chain |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Foundation: errors, KV helpers, env | PR 1 | `vitest run worker/vault/errors.test.ts` | N/A | Revert `errors.ts`, `starkscan-persistence.ts`, `wrangler.toml` |
| 2 | Core: provider submit/poll/classifier/attestation/limiter | PR 2 | `vitest run worker/vault/starkscan-proof-provider.test.ts` | `tsx worker/vault/run-sepolia.ts --dry-run` | Revert `starkscan-proof-provider.ts` |
| 3 | Integration: factory, on-demand wiring, tests | PR 3 | `vitest run worker/vault/vault-service.test.ts` | `wrangler dev` | Revert `vault-service.ts`, `prover-on-demand.ts` |

## Phase 1: Foundation

- [x] 1.1 `errors.ts` — AC: Terminal/Retryable/Budget code+retryAfter. Deps: none. Size: S. Files: `worker/vault/errors.ts`. Verify: `vitest errors.test.ts`
- [x] 1.2 `starkscan-persistence.ts` KV 24h TTL. AC: putJob 202, putProof atomic. Deps: 1.1. Size: S. Files: `worker/vault/starkscan-persistence.ts`. Verify: mock KV
- [x] 1.3 Env `STARKSCAN_API_KEY` + `STARKSCAN_DAILY_BUDGET`. AC: secret not vars, default 100. Deps: none. Size: XS. Files: `wrangler.toml`. Verify: `wrangler types`

## Phase 2: Core Adapter

- [x] 2.1 Provider POST `/v1/SN_MAIN/prove` headers+block. AC: 202 persists jobId; else classified. Deps: 1.1,1.2. Size: M. Files: `starkscan-proof-provider.ts`. Verify: mocked fetch
- [x] 2.2 Classifier 9 codes `24→re-pin` `55/61/1000/-32603→terminal` `prover_*→retry/wait`. AC: terminal no poll. Deps: 2.1. Size: S. Files: `starkscan-proof-provider.ts`. Verify: table-driven vitest
- [x] 2.3 Polling `GET /prove/{jobId}` pollAfterSeconds+cap30s+maxAttempts. AC: waits≥hint; maxAttempts throws. Deps: 2.1. Size: M. Files: `starkscan-proof-provider.ts`. Verify: fake timers
- [x] 2.4 Attestation `now<issued_at+300-30-5` → additionalData. AC: 260s valid, 270s reject. Deps: 2.3. Size: S. Files: `starkscan-proof-provider.ts`. Verify: vitest clock
- [x] 2.5 Rate limiter KV `hash+UTC-date`+Retry-After. AC: under inc; at cap defer; midnight reset. Deps: 1.2,2.1. Size: S. Files: `starkscan-proof-provider.ts`. Verify: vitest

## Phase 3: Integration

- [x] 3.1 Factory `STARKSCAN_API_KEY`>`PROVING_SERVICE_URL`>mock +mainnet gate. AC: 6 scenarios pass. Deps: 2.1. Size: S. Files: `vault-service.ts`. Verify: `vitest vault-service.test.ts`
- [x] 3.2 `prover-on-demand.ts` Starkscan-first before Freestyle. AC: key skips VM; unset no regress. Deps: 3.1. Size: XS. Files: `prover-on-demand.ts`. Verify: stub not called
- [x] 3.3 E2E prove→persist→CallAndProof blip resume. AC: once-only; retry same Idempotency-Key. Deps: 2.3,2.4,3.1. Size: S. Files: `starkscan-proof-provider.ts`,`vault-service.ts`. Verify: mock KV+fetch

## Phase 4: Testing

- [ ] 4.1 Unit classifier/attestation/limiter. AC: full branch cover. Deps: 2.2,2.4,2.5. Size: S. Files: `*.test.ts`. Verify: `vitest --coverage`
- [ ] 4.2 Unit polling+maxAttempts+persist. AC: spec scenarios pass. Deps: 2.3,1.2. Size: S. Files: `starkscan-proof-provider.test.ts`. Verify: fake timers
- [ ] 4.3 Integration factory priority+gate. AC: all selection scenarios. Deps: 3.1. Size: S. Files: `vault-service.test.ts`. Verify: `vitest vault-service.test.ts`

## Phase 5: Docs

- [ ] 5.1 Docs AGENTS.md+JSDoc mainnet-only scope. AC: rollback clear secret. Deps: 3.1. Size: XS. Files: `AGENTS.md`,`wrangler.toml`. Verify: review
- [ ] 5.2 Audit no log `STARKSCAN_API_KEY`. AC: only Env reads. Deps: 2.1. Size: XS. Files: `starkscan-proof-provider.ts`. Verify: `grep worker/`
