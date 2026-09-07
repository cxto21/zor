/**
 * Vault Service — SDK-driven STRK20 privacy pool integration (Master-Receiver Model).
 *
 * Replaces the broken ad-hoc mock (`compile_actions` via starknet_call) with the
 * OFFICIAL starknet-privacy SDK flow:
 *
 *   1. Compile high-level `Actions` → `ClientAction[]` (ActionCompiler)
 *   2. Build + sign a proof invocation against the pool `__execute__` with the viewing key
 *   3. Prove → `CallAndProof` whose `.call` targets `apply_actions` (NOT compile_actions)
 *      and whose `.proof.proofFacts` carry the VIRTUAL_SNOS facts the pool validates
 *      in `accountDeploymentData`.
 *
 * Master-Receiver Pivot: Single master account (0x12f8b...) is registered once in the pool.
 * Users (already registered via Ready wallet) private-transfer STRK to MASTER_ADDRESS via
 * wallet.strk20InvokeTransaction. Worker attributes payments by sender channel via discoverNotes.
 *
 * Proving: Uses ProvingServiceProofProvider when PROVING_SERVICE_URL is set (real VIRTUAL_SNOS
 * proofs via transaction-prover). Falls back to CallMockProofProvider for local dev (Alchemy
 * Sepolia without simulateTransaction). Real proofs need 10-block maturity (provingBlockId = head-10)
 * so the blockifier can verify the block hash in proofFacts.
 *
 * NOTE: Settlement via `apply_actions` on the REAL Sepolia pool requires genuine
 * Virtual SNOS proofs (the pool validates `proof_facts` against the blockifier).
 * This service produces the correct upstream structure and is the foundation for
 * that; wiring a real prover (starknet-privacy prover / AVNU paymaster) or a devnet
 * with a mock-compatible pool swaps only the `provingProvider`.
 *
 * Prover requirement: real VIRTUAL_SNOS proof needs PROVING_SERVICE_URL
 * (ghcr.io/starkware-libs/starknet-privacy/transaction-prover:PRIVACY-0.14.3-RC.2 on Fly/Railway)
 * with 10-block maturity (provingBlockId = head-10).
 */

import {
  Account,
  Contract,
  RpcProvider,
  constants,
  type Call,
} from "starknet";
import {
  createPrivateTransfers,
  ProvingServiceProofProvider,
} from "@starkware-libs/starknet-privacy-sdk";
import {
  CallMockProofProvider,
  ContractDiscoveryProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import { generateViewingKey } from "../src/shield-service/viewing-keys";
import { createStarkscanProviderFromEnv } from "./starkscan-proof-provider";
import type { StarkscanKvNamespace } from "./starkscan-persistence";

// ============ Constants ============

const DEFAULT_POOL_CONTRACT_ADDRESS =
  "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const DEFAULT_STRK_TOKEN_ADDRESS =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
// Default to mainnet; override via env CHAIN_ID if needed.
const CHAIN_ID = constants.StarknetChainId.SN_MAIN;
const CHAIN_ID_MAIN = constants.StarknetChainId.SN_MAIN;
// Backwards-compat aliases for external imports
const POOL_CONTRACT_ADDRESS = DEFAULT_POOL_CONTRACT_ADDRESS;
const STRK_TOKEN_ADDRESS = DEFAULT_STRK_TOKEN_ADDRESS;

function isMainnetChainId(chainId: string): boolean {
  return chainId === CHAIN_ID_MAIN;
}

// ============ Public Result Types ============

export type VaultExecuteResult = {
  /** The `apply_actions` call that must be submitted to settle this action. */
  call: Call;
  /** Proof facts to put in `accountDeploymentData` of the settlement V3 INVOKE. */
  proofFacts: string[];
  /** L2-to-L1 message payload `[class_hash, ...server_actions]`. */
  proofOutput: string[];
  /** Minimal PRIVACY note-free summary for the worker/frontend. */
  warnings: { code: string; message: string }[];
};

// ============ Vault Service ============

export class VaultService {
  private provider: RpcProvider;
  private poolContract: Contract;
  private privateTransfers: ReturnType<typeof createPrivateTransfers>;
  private poolAddress: string;
  private strkAddress: string;

  constructor(
    private config: {
      rpcUrl: string;
      masterAddress: string;
      masterPrivateKey: string;
      provingServiceUrl?: string;
      starkscanApiKey?: string;
      starkscanDailyBudget?: string;
      kv?: StarkscanKvNamespace;
      chainId?: string;
      starkscanBaseUrl?: string;
      poolContractAddress?: string;
      strkTokenAddress?: string;
    },
  ) {
    this.poolAddress = config.poolContractAddress ?? DEFAULT_POOL_CONTRACT_ADDRESS;
    this.strkAddress = config.strkTokenAddress ?? DEFAULT_STRK_TOKEN_ADDRESS;
    this.provider = new RpcProvider({ nodeUrl: config.rpcUrl });

    // A real starknet.js Account is the `PrivateTransfersUser` the SDK expects:
    // it supplies `signTransaction`/`getPubKey` for signing proof invocations.
    const account = new Account({
      provider: this.provider,
      address: config.masterAddress,
      signer: config.masterPrivateKey,
      cairoVersion: "1",
    });

    // Typed contract instance used by ContractDiscoveryProvider (on-chain reads only).
    // NOTE: ContractDiscoveryProvider is kept for now; IndexerDiscoveryProvider is preferred
    // for prod (requires indexer URL, not yet deployed) but not exported in this env.
    this.poolContract = new Contract({
      abi: PrivacyPoolABI,
      address: this.poolAddress,
      providerOrAccount: this.provider,
    }).typedv2(PrivacyPoolABI);

    // Proving provider selection: STARKSCAN_API_KEY (mainnet) > PROVING_SERVICE_URL > mock.
    // Starkscan is mainnet-only — gated by chainId check; Sepolia/test falls through.
    const chainId = config.chainId ?? CHAIN_ID;
    let provingProvider: ReturnType<typeof createPrivateTransfers> extends never ? never : unknown = null as unknown;
    const starkscanKey = config.starkscanApiKey?.trim();
    if (starkscanKey && isMainnetChainId(chainId) && config.kv) {
      const p = createStarkscanProviderFromEnv(
        { STARKSCAN_API_KEY: starkscanKey, STARKSCAN_DAILY_BUDGET: config.starkscanDailyBudget },
        config.kv,
        { baseUrl: config.starkscanBaseUrl },
      );
      if (p) provingProvider = p as unknown as typeof provingProvider;
    }
    if (!provingProvider && config.provingServiceUrl) {
      provingProvider = new ProvingServiceProofProvider(config.provingServiceUrl, chainId as typeof CHAIN_ID) as unknown as typeof provingProvider;
    }
    if (!provingProvider) {
      provingProvider = new CallMockProofProvider(this.provider as unknown as never, chainId as typeof CHAIN_ID, {
        validateSignature: false,
      }) as unknown as typeof provingProvider;
    }

    this.privateTransfers = createPrivateTransfers({
      account,
      viewingKeyProvider: {
        // Reuse the deterministic [1, N/2] viewing-key derivation already in the worker.
        // Must return BigInt (not string) — SDK ViewKey range check expects bigint.
        getViewingKey: async () => BigInt((await generateViewingKey(config.masterPrivateKey)).privateKey),
      },
      provingProvider,
      discoveryProvider: new ContractDiscoveryProvider(this.poolContract as never),
      poolContractAddress: this.poolAddress,
    });
  }

  private toResult(r: { callAndProof: { call: Call; proof: { proofFacts: string[]; output: string[] } } }): VaultExecuteResult {
    return {
      call: r.callAndProof.call,
      proofFacts: r.callAndProof.proof.proofFacts,
      proofOutput: r.callAndProof.proof.output,
      warnings: [],
    };
  }

  private get defaultOptions() {
    return {
      autoRegister: true,
      autoSetup: true,
      autoDiscover: { channels: "missing" as const, notes: "all" as const },
      autoSelectNotes: "all" as const,
    };
  }

  /**
   * Build the register proof call (SetViewingKey + auto channel setup).
   */
  async register(): Promise<VaultExecuteResult> {
    const result = await this.privateTransfers
      .build(this.defaultOptions)
      .register()
      .execute();
    return this.toResult(result);
  }

  /**
   * Build the shield (deposit) proof call for STRK into the pool.
   *
   * Builder chain: .with(STRK).deposit([{ amount }]).done().execute()
   */
  async shield(amount: bigint): Promise<VaultExecuteResult> {
    const result = await this.privateTransfers
      .build(this.defaultOptions)
      .with(this.strkAddress)
      .deposit({ amount })
      .done()
      .execute();
    return this.toResult(result);
  }

  /**
   * Build the unshield (withdraw) proof call for STRK out of the pool.
   *
   * Builder chain: .with(STRK).withdraw({ recipient, amount }).done().execute()
   */
  async unshield(amount: bigint, recipient: string): Promise<VaultExecuteResult> {
    const result = await this.privateTransfers
      .build(this.defaultOptions)
      .with(this.strkAddress)
      .withdraw({ recipient, amount })
      .done()
      .execute();
    return this.toResult(result);
  }

  /**
   * Discover notes for the master account (incoming private transfers).
   * Used by /verify-private-transfer to attribute payments by sender channel.
   */
  async discoverNotes(params?: { blockIdentifier?: unknown }) {
    return this.privateTransfers.discoverNotes(params as never);
  }

  /**
   * Discover channels for given recipients (sender attribution).
   */
  async discoverChannels(recipients: unknown, params?: unknown) {
    return this.privateTransfers.discoverChannels(recipients as never, params as never);
  }

  /** Whether a real proving service is configured (vs mock fallback). */
  isMockProver(): boolean {
    return !this.config.provingServiceUrl && !this.config.starkscanApiKey?.trim();
  }

  /** Whether Starkscan is the active provider (mainnet only). */
  isStarkscanProver(): boolean {
    const chainId = this.config.chainId ?? CHAIN_ID;
    return !!this.config.starkscanApiKey?.trim() && isMainnetChainId(chainId) && !!this.config.kv;
  }

  /** Expose raw privateTransfers for advanced callers (e.g. verify-private-transfer). */
  get rawTransfers() {
    return this.privateTransfers;
  }

  /** Top up session minutes */
  async topUp(token: string, minutes: number): Promise<{ success: boolean; newTotalMinutes: number; message: string }> {
    if (!env.SESSIONS) return { success: false, newTotalMinutes: 0, message: "Sessions KV not configured" };
    if (!token || minutes <= 0) return { success: false, newTotalMinutes: 0, message: "Invalid token or minutes" };

    const key = `${SESSION_PREFIX}${token}`;
    const existing = await env.SESSIONS.get(key);
    if (!existing) return { success: false, newTotalMinutes: 0, message: "Session not found" };

    const session: SessionData = JSON.parse(existing);
    session.totalMinutes = (session.totalMinutes || 0) + minutes;

    const ttl = session.totalMinutes * 60 + 300;
    await env.SESSIONS.put(key, JSON.stringify(session), { expirationTtl: ttl });

    const minutesAvailable = session.totalMinutes;
    return { success: true, newTotalMinutes: minutesAvailable, message: `+${minutes} minutes added. Total: ${minutesAvailable} min` };
  }
}

// ============ Factory ============

export function createVaultService(env: {
  STARKNET_RPC_URL: string;
  MASTER_ADDRESS: string;
  MASTER_PRIVATE_KEY: string;
  PROVING_SERVICE_URL?: string;
  STARKSCAN_API_KEY?: string;
  STARKSCAN_DAILY_BUDGET?: string;
  CHAIN_ID?: string;
  SESSIONS?: StarkscanKvNamespace;
  PROOF_JOBS?: StarkscanKvNamespace;
  STARKSCAN_BASE_URL?: string;
  POOL_CONTRACT_ADDRESS?: string;
  STRK_TOKEN_ADDRESS?: string;
}): VaultService {
  const kv = (env.PROOF_JOBS ?? env.SESSIONS) as StarkscanKvNamespace | undefined;
  return new VaultService({
    rpcUrl: env.STARKNET_RPC_URL,
    masterAddress: env.MASTER_ADDRESS,
    masterPrivateKey: env.MASTER_PRIVATE_KEY,
    provingServiceUrl: env.PROVING_SERVICE_URL,
    starkscanApiKey: env.STARKSCAN_API_KEY,
    starkscanDailyBudget: env.STARKSCAN_DAILY_BUDGET,
    kv,
    chainId: env.CHAIN_ID,
    starkscanBaseUrl: env.STARKSCAN_BASE_URL,
    poolContractAddress: (env as any).POOL_CONTRACT_ADDRESS ?? DEFAULT_POOL_CONTRACT_ADDRESS,
    strkTokenAddress: (env as any).STRK_TOKEN_ADDRESS ?? DEFAULT_STRK_TOKEN_ADDRESS,
  });
}

export { isMainnetChainId };
