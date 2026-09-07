# Proposal: Starkscan Prover Integration (Hybrid Phased)

## Intent

Zor's STRK20 privacy pool settlement is blocked because `CallMockProofProvider` produces fake VIRTUAL_SNOS proof_facts that the pool's blockifier rejects with `NO_REPLAY_PROTECTION`. Starkscan offers a managed, free, documented prover API that produces genuine proofs — the fastest path to a working mainnet settlement pipeline.

## Scope

### In Scope (Phase 1 — this change)
- `StarkscanProofProvider` adapter implementing the same interface as `ProvingServiceProofProvider`
- Async prove flow: POST job → poll with backoff → persist result immediately (delivered once)
- Depositor screening attestation handling (5-min expiring `additional_data.signature`)
- Error handling for all documented Starkscan error codes (block not found, budget exhausted, concurrency, queue full)
- Provider selection logic: `STARKSCAN_API_KEY` env → Starkscan; `PROVING_SERVICE_URL` → self-hosted; default → mock
- Wire into `VaultService` constructor alongside existing providers
- Daily budget rate limiting on Zor's side to prevent Starkscan budget blowout

### Out of Scope
- Freestyle prover fix for Sepolia (Phase 2 — separate change)
- Self-hosted prover migration (Phase 3 — later optimization)
- Starkscan integration tests on mainnet (requires operator-issued prove scope first)
- Legacy `worker/src/shield-service/` cleanup (separate concern)

## Capabilities

### New Capabilities
- `starkscan-proving-provider`: Async Starkscan API adapter — job submission, polling, result persistence, error classification, depositor screening attestation
- `proving-provider-selection`: Env-based provider routing — Starkscan (mainnet) vs self-hosted (Sepolia) vs mock (dev)

### Modified Capabilities
None — no existing specs in `openspec/specs/`.

## Approach

**Hybrid phased (Approach B from exploration):**

1. Create `worker/vault/starkscan-proof-provider.ts` — Starkscan adapter matching the SDK's proving provider interface
2. Add provider selection to `VaultService` constructor based on env vars
3. Implement robust polling with exponential backoff + immediate result persistence
4. Handle screened deposits: check attestation expiry margin, include in `Proof.additionalData`
5. Add rate limiter keyed to Starkscan daily budget

Provider priority chain:
```
STARKSCAN_API_KEY (mainnet) → PROVING_SERVICE_URL (Sepolia/self-hosted) → default (mock)
```

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `worker/vault/starkscan-proof-provider.ts` | New | Starkscan API adapter |
| `worker/vault/vault-service.ts` | Modified | Provider selection logic in constructor |
| `worker/src/prover-on-demand.ts` | Modified | Add Starkscan path before Freestyle branch |
| Worker env/config | Modified | `STARKSCAN_API_KEY` secret + provider routing env |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Starkscan prove scope requires operator approval (not self-service) | High | Request approval early; block mainnet testing until granted |
| Mainnet-only — no Sepolia test path via Starkscan | Certain | Mock for dev/structure, Freestyle for Sepolia real proofs |
| Result delivered once — network blip loses proof | Medium | Robust polling with immediate persistence + retry on transient errors |
| Screened deposit attestation 300s expiry is tight | Medium | Check `issued_at` + clock skew margin; include broadcast time budget |
| Daily budget exhaustion under high volume | Low | Zor-side rate limiter caps proofs/day; graceful degradation |
| Starkscan external dependency — downtime affects settlement | Low | Queue proof attempts, retry on next block; fallback to mock for non-settlement |

## Rollback Plan

- Set `STARKSCAN_API_KEY` env to empty/undefined → `VaultService` falls back to `PROVING_SERVICE_URL` or mock
- No data migration needed — provider selection is purely runtime config
- Revert the `starkscan-proof-provider.ts` file and related env wiring

## Dependencies

- **Operator approval**: Starkscan prove scope must be issued before mainnet testing
- **Starkscan API key**: `X-Starkscan-Api-Key` header value
- **starknet-privacy SDK**: Already at `@0.14.3-rc.6` — no upgrade needed

## Success Criteria

- [ ] `StarkscanProofProvider` successfully submits a prove job and retrieves genuine VIRTUAL_SNOS proof_facts
- [ ] Provider selection correctly routes by env: Starkscan → self-hosted → mock
- [ ] Depositor screening attestation is included in `Proof.additionalData` for shield transactions
- [ ] Error codes are classified and handled (retry vs fail vs wait)
- [ ] Rate limiter prevents exceeding Starkscan daily budget
- [ ] Settlement via `apply_actions` succeeds on a real pool with Starkscan proofs (requires operator scope)
- [ ] No regression: mock path still works for local dev without any env vars set
