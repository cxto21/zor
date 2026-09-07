# Exploration: Starkscan STRK20 Prover Integration

**Date**: 2026-09-07
**Change**: starkscan-prover
**Status**: exploration complete

---

## Current State

### Two Shield Implementations

Zor has **two parallel implementations** for STRK20 privacy pool interaction:

1. **`worker/src/shield-service/`** — Legacy raw-RPC implementation using `MockProver` (builds 9-element VIRTUAL_SNOS proof_facts manually via `compile_actions` VIEW call). Still wired into `/shield` and `/unshield` endpoints in `index.ts`.

2. **`worker/vault/vault-service.ts`** — Official SDK-driven implementation using `@starkware-libs/starknet-privacy-sdk@0.14.3-rc.6`. Supports three proving providers:
   - `CallMockProofProvider` (mock, no real proof — current default)
   - `ProvingServiceProofProvider` (self-hosted `transaction-prover` via Fly/Railway)
   - Freestyle on-demand VMs via `prover-on-demand.ts` (branch from snapshot, auto-pause)

### The Settlement Problem (Gap #2 in AGENTS.md)

The core blocker identified in AGENTS.md:
> Settlement via `apply_actions` on the REAL Sepolia pool requires genuine Virtual SNOS proofs (the pool validates `proof_facts` against the blockifier). This service produces the correct upstream structure and is the foundation for that.

Current state:
- `run-sepolia.ts` builds correct `apply_actions` CallAndProof structure (verified)
- 9 proof_facts are structurally valid but NOT genuine ZK proofs
- Pool's `__validate__` rejects fake proof_facts with `NO_REPLAY_PROTECTION`
- Self-hosted prover (`transaction-prover:PRIVACY-0.14.3-RC.2`) blocked in sandbox (OOM/SIGTERM)

### Prover Infrastructure

| Path | Provider | Proof Type | Status |
|------|----------|-----------|--------|
| Default | `CallMockProofProvider` | Mock VIRTUAL_SNOS (9 facts) | Working, not settlement-ready |
| `PROVING_SERVICE_URL` | `ProvingServiceProofProvider` | Real VIRTUAL_SNOS | Needs deployment (self-hosted) |
| Freestyle on-demand | `prover-on-demand.ts` → snapshot branch | Real VIRTUAL_SNOS | Working but burns free-tier compute |

---

## Starkscan STRK20 Prover API Analysis

### What It Is
Starkscan is the **authenticated front door** for the Starknet Foundation's STRK20 transaction prover. It relays proof requests to the official prover infrastructure.

### Key Characteristics

| Property | Value |
|----------|-------|
| Network | **Mainnet only** — no Sepolia |
| Auth | `X-Starkscan-Api-Key` header (operator-issued, prove scope required) |
| Protocol | Async: submit job → poll until terminal |
| Transaction type | Invoke only |
| Block pinning | Explicit finalized block required |
| Budget | Per-key daily + concurrency limits |
| Result delivery | **Once** — delivered on first terminal poll, then dropped from memory |
| Cost | Free (budgeted, not pay-per-proof) |
| Request cap | 1 MiB |

### Flow

```
1. Build Invoke TX (apply_actions calldata)
2. POST /v1/SN_MAIN/prove { block_id, transaction } + Idempotency-Key
3. Receive jobId (202 Accepted)
4. Poll GET /v1/SN_MAIN/prove/{jobId}
5. On terminal: persist result IMMEDIATELY (delivered once)
6. result.proof + result.proof_facts → submit settlement TX
```

### Depositor Screening (Screened Deposits)

For deposits, the prover attaches an **expiring attestation** to `additional_data.signature`:
- Pool requires `additional_data.signature` if AND ONLY IF transaction contains a deposit
- Attestation expires in 300 seconds (`DEPOSITOR_VALIDATION_MAX_AGE`)
- Must be included in calldata via `Proof.additionalData` (SDK handles this)
- `issued_at` timestamp starts when prover screens (during proving, not queuing)

### Error Handling

| Code | Meaning | Action |
|------|---------|--------|
| `24` | Block not found | Re-pin to older block |
| `55` | Account validation failed | Fix transaction |
| `61` | Unsupported tx version | Use V3 Invoke |
| `1000` | Invalid tx input | Fix calldata |
| `-32603` | Tx reverted | Fix transaction (diagnostic in error.data) |
| `prover_unavailable` | Absorbed error | Retry same idempotency key |
| `prover_daily_budget_exhausted` | Out of proofs | Wait UTC midnight (Retry-After) |
| `prover_key_concurrency` | Max in-flight proofs | Wait for current proof to finish |
| `prover_queue_full` | Queue saturated | Self-clearing, retry |

---

## Comparison: Starkscan vs Current Approaches

| Dimension | Mock (CallMockProofProvider) | Self-hosted (transaction-prover) | Starkscan Prover |
|-----------|---------------------------|----------------------------------|-----------------|
| **Proof authenticity** | Fake (9 VIRTUAL_SNOS facts) | Real VIRTUAL_SNOS | Real VIRTUAL_SNOS |
| **Settlement on real pool** | Reverts (NO_REPLAY_PROTECTION) | Works (real proofs) | Works (real proofs) |
| **Network** | Any (Sepolia/Mainnet) | Any (self-hosted) | **Mainnet only** |
| **Infrastructure** | None | Freestyle VM or Fly/Railway | None (Starkscan managed) |
| **Latency** | Instant (~1s) | 1-5 min (prover workload) | 1-10 min (queue + proving) |
| **Cost** | Free | Free (infra cost ~$30-50/mo) | Free (budgeted) |
| **Privacy** | High (local, no external calls) | High (self-hosted) | Medium (sees tx temporarily, but no persistence) |
| **Availability** | Always | Depends on VM state | Depends on Starkscan infrastructure |
| **Screening** | N/A | Not implemented | Built-in (depositor screening + attestation) |
| **Trust** | Full control | Full control | Trust Starkscan relay (no data persistence claimed) |
| **Deployment risk** | None | High (sandbox OOM, infra complexity) | Low (managed service) |

---

## Approach Mapping

### Approach A: Starkscan as Primary Mainnet Prover

Replace the proving provider with a Starkscan adapter. Use `CallMockProofProvider` for dev/Seplia, Starkscan for mainnet settlement.

**Implementation sketch:**
1. Create `StarkscanProofProvider` implementing the same interface as `ProvingServiceProofProvider`
2. POST to `https://api.starkscan.co/v1/SN_MAIN/prove`
3. Poll with backoff (honor `pollAfterSeconds`)
4. Parse `result.proof` + `result.proof_facts` + `result.additional_data.signature` (for screened deposits)
5. Persist result immediately (delivered once)
6. Wire into `VaultService` as third proving provider option
7. Set `PROVING_SERVICE_URL` env to `starkscan` or separate `STARKSCAN_API_KEY`

**Pros:**
- No infrastructure to manage (managed prover)
- Real VIRTUAL_SNOS proofs (settlement works)
- Depositor screening built-in
- Free (budgeted)
- Low deployment risk

**Cons:**
- **Mainnet only** — cannot test on Sepolia
- Budget limits (daily + concurrency)
- External dependency (Starkscan availability)
- Privacy: Starkscan sees transaction temporarily (but no persistence)
- Latency: async with queue wait
- `result` delivered once — must persist immediately or lose proof
- Requires operator-issued prove scope (not self-service)

**Effort:** Medium (2-3 days) — adapter + integration testing on mainnet

### Approach B: Keep Mock for Dev, Freestyle for Sepolia, Starkscan for Mainnet

Hybrid: mock → Freestyle → Starkscan as progressive proving providers.

**Implementation sketch:**
1. Keep `CallMockProofProvider` as default (dev + fast iteration)
2. Keep Freestyle on-demand VMs for Sepolia testing
3. Add Starkscan adapter as mainnet-only fallback
4. `prover-on-demand.ts` extended: if mainnet chain + Starkscan key → Starkscan

**Pros:**
- Full development workflow (mock → real)
- Sepolia testing with real proofs (Freestyle)
- Mainnet production with Starkscan
- Graceful fallback chain

**Cons:**
- Most complex (3 providers)
- Freestyle compute costs for Sepolia testing
- Starkscan still mainnet-only
- More code paths to maintain

**Effort:** Medium-High (3-4 days)

### Approach C: Self-Hosted Prover Only (No Starkscan)

Double down on self-hosted `transaction-prover` via Freestyle, avoid external dependency.

**Implementation sketch:**
1. Deploy `transaction-prover:PRIVACY-0.14.3-RC.2` on Freestyle with adequate resources (8 vCPU / 16 GiB)
2. Optimize snapshot for fast branch (<400ms)
3. Keep existing `ProvingServiceProofProvider` + `prover-on-demand.ts`
4. No Starkscan integration

**Pros:**
- Full control (privacy, availability, no external trust)
- Works on both Sepolia and Mainnet
- No budget limits (pay for compute only)

**Cons:**
- Infrastructure complexity (VM management, OOM risk)
- Compute cost (~$30-50/mo minimum)
- No depositor screening (must implement separately)
- Sandbox SIGTERM issue still unresolved
- More ops burden

**Effort:** High (5-7 days — infra + debugging sandbox OOM)

---

## Recommendation

**Approach B (Hybrid)** is the recommended path, but implemented in phases:

**Phase 1 (Immediate):** Create `StarkscanProofProvider` adapter. This is the lowest-effort path to real proofs for mainnet settlement. Mock stays for dev. Effort: ~2 days.

**Phase 2 (Next):** Fix Freestyle prover for Sepolia testing. The sandbox SIGTERM issue needs resolution (adequate RAM/CPU allocation). Effort: ~3 days.

**Phase 3 (Later):** Optimize — if Starkscan budget/latency proves insufficient, migrate mainnet to self-hosted prover.

The reasoning:
- Starkscan is **the fastest path to settlement** (managed, free, documented)
- Mainnet-only limitation is acceptable because Sepolia pool testing can use mock (for structure) or Freestyle (for real proofs)
- Self-hosted is the eventual production target but has unresolved infra issues
- Starkscan gives us a working mainnet proof pipeline while we solve the Freestyle/OOM problem

---

## Risks

1. **Starkscan prove scope requires operator approval** — not self-service. Access may not be granted immediately.
2. **Mainnet-only** — no way to test settlement on Sepolia via Starkscan. Must rely on Freestyle for Sepolia real-proofs.
3. **Result delivered once** — if the Worker misses the first terminal poll (network blip), the proof is gone. Must implement robust polling with immediate persistence.
4. **Screened deposits require attestation** — the 300s expiry is tight. Must check `issued_at` against clock skew and include broadcast time in margin calculation.
5. **Daily budget exhaustion** — under high volume, the prover may hit daily limits. Need rate limiting on Zor's side to prevent budget blowout.
6. **Starkscan is an external dependency** — downtime affects settlement. Need graceful degradation (queue proof attempts, retry on next block).

---

## Ready for Proposal

**Yes** — the exploration is complete. The orchestrator should:
1. Ask the user to decide between Approach A (Starkscan-only) or Approach B (Hybrid)
2. If Approach B: proceed to proposal phase with Phase 1 scope (Starkscan adapter)
3. Note that Starkscan prove scope requires operator approval — user should initiate that early
