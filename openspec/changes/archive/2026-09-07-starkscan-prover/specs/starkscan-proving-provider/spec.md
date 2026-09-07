# Starkscan Proving Provider Specification

## Purpose

Async adapter to the Starkscan STRK20 prover API (mainnet only). Submits invoke prove jobs, polls until terminal with backoff, persists the delivered-once result immediately, classifies documented error codes, and attaches the depositor screening attestation for shielded deposits.

## Requirements

### Requirement: Job Submission with Idempotency-Key

The system SHALL submit a prove job to the Starkscan API via `POST /v1/SN_MAIN/prove` with an `Idempotency-Key` header and an explicitly pinned finalized block. The system MUST send `X-Starkscan-Api-Key` on every request. A submitted job that does not yield a `202 Accepted` with a `jobId` SHALL NOT be considered submitted.

#### Scenario: Successful submission

- GIVEN a built invoke transaction and a pinned finalized block
- WHEN the provider POSTs the prove job with an `Idempotency-Key`
- THEN the API returns `202 Accepted` with a `jobId`
- AND the provider stores the `jobId` keyed by the idempotency key for later polling

#### Scenario: Submission retry is idempotent

- GIVEN a prior submission failed with a transient error (`prover_unavailable`)
- WHEN the provider re-submits with the same `Idempotency-Key`
- THEN the API returns the same job (no duplicate proof job)

#### Scenario: Submission rejects bad input

- GIVEN transaction calldata is invalid (error `1000`)
- WHEN the provider POSTs the job
- THEN the provider classifies the error as terminal and does not poll

### Requirement: Polling with Backoff Honoring `pollAfterSeconds`

The system SHALL poll `GET /v1/SN_MAIN/prove/{jobId}` with exponential backoff, scheduling the next poll no earlier than the server-provided `pollAfterSeconds`. Polling SHALL continue until the job reaches a terminal state (success or terminal error) or a configured max attempts is reached.

#### Scenario: Backoff follows server hint

- GIVEN a poll response returns `pollAfterSeconds: 5`
- WHEN the provider schedules the next poll
- THEN it waits at least 5 seconds before the next request

#### Scenario: Terminal success is detected

- GIVEN a poll returns a success status with `result.proof` and `result.proof_facts`
- WHEN the provider processes the response
- THEN the job is marked terminal and polling stops

#### Scenario: Reaching max attempts without terminal state

- GIVEN a job is non-terminal after the configured max attempts
- WHEN the provider exhausts attempts
- THEN it raises an error and does not silently drop the job

### Requirement: Once-Only Result Persistence

Because the Starkscan result is delivered only once, the system SHALL persist the terminal result (proof, proof_facts, additional_data) immediately and atomically on the first terminal poll. The system MUST NOT re-poll or re-submit for an already-persisted terminal result.

#### Scenario: Result persisted on first terminal poll

- GIVEN a poll returns a terminal success state
- WHEN the provider processes it
- THEN the proof and proof_facts are persisted before any further request
- AND the job is recorded as delivered

#### Scenario: Network blip before persistence is retried

- GIVEN a network failure occurs before the terminal result is persisted
- WHEN the worker recovers
- THEN it continues polling the same job until the result is persisted (delivered-once is not lost before persistence)

### Requirement: Error Code Classification and Handling

The system SHALL classify Starkscan error codes into retry, terminal-fail, or wait-and-retry buckets, and SHALL apply the documented action per code: `24` re-pin to older block, `55` fix account validation, `61` use V3 invoke, `1000` and `-32603` terminal (fix tx), `prover_unavailable` retry same key, `prover_daily_budget_exhausted` wait for reset, `prover_key_concurrency` wait for in-flight, `prover_queue_full` self-clearing retry.

#### Scenario: Block-not-found re-pins

- GIVEN the API returns error `24` (block not found)
- WHEN the provider handles it
- THEN it re-pins to an older finalized block and retries

#### Scenario: Budget exhausted waits

- GIVEN the API returns `prover_daily_budget_exhausted` with a `Retry-After`
- WHEN the provider handles it
- THEN it pauses until the retry time or UTC midnight and does not keep hammering the API

#### Scenario: Concurrency limit defers

- GIVEN the API returns `prover_key_concurrency`
- WHEN the provider handles it
- THEN it waits for an in-flight proof to finish before resubmitting

#### Scenario: Queue full is retried

- GIVEN the API returns `prover_queue_full`
- WHEN the provider handles it
- THEN it waits per backoff and retries the same job

#### Scenario: Terminal fixable errors fail the job

- GIVEN the API returns `55`, `61`, `1000`, or `-32603`
- WHEN the provider handles it
- THEN it classifies the job as terminal and surfaces the diagnostic without polling further

### Requirement: Depositor Screening Attestation (300s)

For transactions containing a deposit, the system SHALL include the expiring attestation `additional_data.signature` in the persisted `Proof.additionalData`. The system SHALL validate the attestation `issued_at` against clock skew and the 300-second `DEPOSITOR_VALIDATION_MAX_AGE` window, leaving margin for broadcast time.

#### Scenario: Screened deposit attestation included

- GIVEN the prover screens and returns `additional_data.signature` within validity
- WHEN the provider builds `Proof.additionalData`
- THEN the attestation is included and attached to the shield transaction

#### Scenario: Attestation near expiry is rejected

- GIVEN an attestation whose `issued_at` plus 300s minus broadcast margin is already in the past
- WHEN the provider validates it
- THEN it fails the proof and requests a fresh screening attestation rather than broadcasting an expired one

### Requirement: Daily Budget Rate Limiting

The system SHALL rate limit prove submissions on Zor's side, keyed to the Starkscan daily budget, so that total proofs per key per day do not exceed the configured cap. Exceeding the cap SHALL cause graceful degradation (queue or defer) rather than error spam.

#### Scenario: Under budget proceeds

- GIVEN the daily proof counter is below the budget cap
- WHEN a prove request arrives
- THEN the request is submitted normally and the counter is incremented

#### Scenario: Budget cap reached

- GIVEN the daily proof counter has reached the budget cap
- WHEN a prove request arrives
- THEN the provider defers or queues the request and does not submit to Starkscan until the budget resets
