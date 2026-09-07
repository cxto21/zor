# Proving Provider Selection Specification

## Purpose

Deterministic environment-based routing of the proving provider so that each runtime selects the correct proof source: Starkscan for mainnet, self-hosted for Sepolia, and mock for local development.

## Requirements

### Requirement: Env-Based Provider Routing

The system SHALL select the proving provider from environment configuration at construction time, following the priority chain: `STARKSCAN_API_KEY` (mainnet) → `PROVING_SERVICE_URL` (self-hosted/Sepolia) → default (mock). The system SHALL resolve exactly one active provider and expose it to `VaultService`.

#### Scenario: Starkscan selected for mainnet

- GIVEN `STARKSCAN_API_KEY` is set
- WHEN `VaultService` is constructed
- THEN the `StarkscanProofProvider` is selected as the active provider

#### Scenario: Self-hosted selected when no Starkscan key

- GIVEN `STARKSCAN_API_KEY` is unset and `PROVING_SERVICE_URL` is set
- WHEN `VaultService` is constructed
- THEN the `ProvingServiceProofProvider` is selected

#### Scenario: Mock selected when neither env is set

- GIVEN neither `STARKSCAN_API_KEY` nor `PROVING_SERVICE_URL` is set
- WHEN `VaultService` is constructed
- THEN the default mock provider is selected
- AND local development works without any proving env vars

### Requirement: Provider Priority Chain

The system SHALL evaluate the provider selection chain in priority order and SHALL use the first configured provider. A higher-priority provider MUST not be bypassed when it is configured, even if a lower-priority provider is also configured.

#### Scenario: Starkscan takes precedence

- GIVEN both `STARKSCAN_API_KEY` and `PROVING_SERVICE_URL` are set
- WHEN `VaultService` is constructed
- THEN Starkscan is used and the self-hosted provider is not activated

#### Scenario: Fallback on missing higher priority

- GIVEN `STARKSCAN_API_KEY` is cleared at runtime
- WHEN `VaultService` is reconstructed
- THEN it falls back to `PROVING_SERVICE_URL` or mock per the chain

### Requirement: Mainnet gating

The system SHALL route the Starkscan provider only for mainnet proof requests. The system SHOULD NOT attempt Starkscan proof for a non-mainnet chain, falling back down the chain instead.

#### Scenario: Starkscan blocked for non-mainnet

- GIVEN a proof request targets a non-mainnet chain and `STARKSCAN_API_KEY` is set
- WHEN the request is routed
- THEN Starkscan is bypassed and a lower-priority provider handling that chain is used
