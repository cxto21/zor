# Design: Starkscan Prover Integration (Hybrid Phased)

## Technical Approach

`StarkscanProofProvider` implements the SDK `ProvingProvider` interface. `VaultService` selects at construction: `STARKSCAN_API_KEY` → Starkscan (mainnet), else `PROVING_SERVICE_URL` → self-hosted, else mock. The adapter wraps Starkscan's async job API — submit with `Idempotency-Key` + pinned block, poll honoring `pollAfterSeconds`, persist-once to KV, classify errors, validate 300s attestation with margin, and rate-limit against daily budget. `prover-on-demand.ts` short-circuits Freestyle when Starkscan is configured.

## Architecture Decisions

| Decision | Option | Tradeoff | Choice |
|----------|--------|----------|--------|
| Provider abstraction | Subclass SDK vs wrapper | Wrapper avoids SDK coupling | **Wrapper `StarkscanProofProvider` matching `ProvingServiceProofProvider` interface** |
| Selection point | Handler vs `VaultService` factory | Handler duplication | **Factory in `VaultService` constructor** |
| Polling | SDK vs worker state machine | SDK has no Starkscan state | **Worker `jobId` loop honoring `pollAfterSeconds` + exp backoff cap 30s** |
| Persistence | Memory vs KV atomic put | Memory lost on restart | **KV put on first terminal poll; idemKey→jobId persisted (TTL 24h)** |
| Error handling | Raw HTTP vs classifier | Callers cannot retry | **Classifier `24,55,61,1000,-32603,prover_*` → retry/re-pin/wait/terminal** |
| Rate limit | Header only vs local counter | Header too late | **KV counter by key-hash+UTC date, checked pre-submit; honor `Retry-After`** |

## Data Flow

```
createVaultService(env) → STARKSCAN_API_KEY? StarkscanProofProvider
                        → else PROVING_SERVICE_URL? ProvingServiceProofProvider
                        → else CallMockProofProvider

prove(tx, block) → POST /v1/SN_MAIN/prove (Idempotency-Key + X-Starkscan-Api-Key + pinned block)
                 ←202 {jobId} (persist idem→jobId)
                 → GET /v1/SN_MAIN/prove/{jobId} (wait pollAfterSeconds) ←{status, result}
                 → terminal? validate attestation (300-30-5), persist proof, return CallAndProof
                 → submit apply_actions(call, proofFacts)
```

Sequence:

```
Worker         Starkscan       KV          Pool
  │ POST /prove  │             │            │
  ├─────────────→│             │            │
  │←202 {jobId}  │             │            │
  ├─put jobId────┼───────────→ │            │
  │ GET /prove/{jobId}         │            │
  ├─────────────→│             │            │
  │←{pending, pollAfter:5}     │            │
  │ GET /prove/{jobId}         │            │
  ├─────────────→│             │            │
  │←{completed, proof}         │            │
  ├─put proof────┼───────────→ │            │
  │ apply_actions(call, proofFacts+attestation)         │
  ├──────────────────────────────────────────→│
```

Security: `STARKSCAN_API_KEY` as Worker secret, never `vars`, never logged. Attestation: `now < issued_at + 300 - 30 (margin) - 5 (skew)` else fail fast. Edge: blip before persist → retry same `Idempotency-Key` → existing `jobId` → re-poll. Budget exhausted → block submits until UTC midnight/`Retry-After`. Concurrency → wait in-flight. Queue full → backoff. Block `24` → re-pin older block.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `worker/vault/starkscan-proof-provider.ts` | Create | `StarkscanProofProvider`, classifier, rate limiter, polling loop |
| `worker/vault/starkscan-persistence.ts` | Create | KV helpers `putJob`/`putProof`, TTL 24h |
| `worker/vault/errors.ts` | Create | `StarkscanTerminalError`, `StarkscanRetryableError`, `BudgetExhaustedError` |
| `worker/vault/vault-service.ts` | Modify | Provider factory + mainnet gate |
| `worker/src/prover-on-demand.ts` | Modify | Starkscan-first branch before Freestyle |
| `worker/wrangler.toml` | Modify | Document `STARKSCAN_API_KEY` secret, `STARKSCAN_DAILY_BUDGET` |

## Interfaces / Contracts

```ts
class StarkscanProofProvider {
  constructor(opts: { apiKey: string; rpcUrl: string; chainId: string; kv: KVNamespace });
  prove(tx: InvokeTx, blockId: BlockId): Promise<CallAndProof>;
}
POST /v1/SN_MAIN/prove  Headers: X-Starkscan-Api-Key, Idempotency-Key
  Body: { invokeTx, blockId } → 202 { jobId } | 4xx { code }
GET /v1/SN_MAIN/prove/{jobId}  Headers: X-Starkscan-Api-Key
  → 200 { status, pollAfterSeconds?, result?: { proof, proof_facts, additional_data }, error?: { code, retryAfter } }

type StarkscanResult = { proof: string[]; proof_facts: string[]; additional_data: { signature: string; issued_at: number } };
const MAX_AGE=300, MARGIN=30, SKEW=5; // valid if now < issued_at + 300 -30 -5
```

Classifier: `24→re-pin+retry`, `55/61/1000/-32603→terminal`, `prover_unavailable→retry`, `prover_daily_budget_exhausted→wait`, `prover_key_concurrency→wait`, `prover_queue_full→backoff`.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Classifier all codes; attestation 300-30-5; limiter cap/UTC reset | Vitest, no network |
| Unit | Polling honors `pollAfterSeconds`, maxAttempts throws | Fake timers, mocked fetch |
| Integration | Factory priority + mainnet gate | Construct `VaultService` varied env |
| Integration | Once-only persist + blip resume via idem→jobId | Mock KV + fetch sequence |
| E2E (manual) | Real submit→poll→`apply_actions` on mainnet | Flagged, needs operator scope |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

No migration. Env-flagged — no secret → fallback unchanged. Deploy → verify mock; `wrangler secret put STARKSCAN_API_KEY` in staging → prod after scope. Rollback: clear secret. `STARKSCAN_DAILY_BUDGET` default 100.

## Open Questions

- [ ] `prove` scope ETA (blocks mainnet E2E)
- [ ] `additional_data.signature` encoding — confirm on first job
- [ ] KV namespace: reuse `SESSIONS` vs new `PROOF_JOBS` (recommend new)
- [ ] Daily budget cap — confirm quota with operator
